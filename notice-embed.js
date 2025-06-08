const fs = require('fs');
const { WebhookClient, EmbedBuilder } = require('discord.js');
const { Octokit } = require('@octokit/rest');
require('dotenv').config(); // Load environment variables

// For proper ES Module support with node-fetch
const nodeFetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

// Get webhook URLs from environment variables
const WEBHOOK_URLS = process.env.WEBHOOK_URLS ? 
    process.env.WEBHOOK_URLS.split(',') : 
    [];

// Get server names for each webhook
const WEBHOOK_NAMES = process.env.WEBHOOK_NAMES ? 
    process.env.WEBHOOK_NAMES.split(',') : 
    WEBHOOK_URLS.map((_, index) => `Server ${index + 1}`);

// Make sure we have names for all webhooks
while (WEBHOOK_NAMES.length < WEBHOOK_URLS.length) {
    WEBHOOK_NAMES.push(`Server ${WEBHOOK_NAMES.length + 1}`);
}

const DB_FILE = process.env.DB_FILE || 'announcements.json';
const RSS_JSON_URL = 'https://api.rss2json.com/v1/api.json?rss_url=https%3A%2F%2Fwww.bracu.ac.bd%2Frss.xml';
const CHECK_INTERVAL_MS = parseInt(process.env.CHECK_INTERVAL_MS) || 30 * 60 * 1000; // Default: 30 minutes

// Extract webhook ID and token from URL
const getWebhookParts = (webhookUrl) => {
    const urlParts = webhookUrl.split('/');
    return {
        id: urlParts[urlParts.length - 2],
        token: urlParts[urlParts.length - 1]
    };
};

function loadPosted() {
    if (fs.existsSync(DB_FILE)) {
        return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    }
    return [];
}

function savePosted(posted) {
    fs.writeFileSync(DB_FILE, JSON.stringify(posted, null, 2));
}

async function postToDiscord(announcement) {
    console.log(`📤 Posting to ${WEBHOOK_URLS.length} Discord server(s): "${announcement.title}"`);
    
    // Format the date in a more readable format if possible
    let pubDate = announcement.pubDate;
    try {
        const date = new Date(announcement.pubDate);
        pubDate = date.toLocaleDateString('en-US', { 
            weekday: 'long', 
            year: 'numeric', 
            month: 'long', 
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        });
    } catch (error) {
        // Keep the original format if parsing fails
        console.log(`⚠️ Could not parse date: ${error.message}`);
    }
    
    // Create embed
    const embed = new EmbedBuilder()
        .setAuthor({
            name: "ব্র্যাকু নোটিশ",
            iconURL: "https://github.com/zawad1804/miscellaneous/blob/main/image-removebg-preview%20(1).jpg?raw=true",
        })
        .setTitle(announcement.title)
        .setURL(announcement.link)
        .addFields(
            {
                name: "Published On:",
                value: pubDate,
                inline: false
            },
            {
                name: "Announcement Link:",
                value: announcement.link,
                inline: false
            }
        )
        .setColor("#336ca6");
    
    const results = [];
    
    // Post to each webhook
    for (let i = 0; i < WEBHOOK_URLS.length; i++) {
        const webhookUrl = WEBHOOK_URLS[i];
        const serverName = WEBHOOK_NAMES[i] || `Server ${i + 1}`;
        
        try {
            // Extract webhook ID and token from URL
            const parts = getWebhookParts(webhookUrl);
            
            // Create webhook client
            const webhookClient = new WebhookClient({ 
                id: parts.id, 
                token: parts.token 
            });
            
            // Send the embed through the webhook
            await webhookClient.send({
                embeds: [embed]
            });
            
            console.log(`✅ Posted to Discord server: ${serverName}`);
            results.push({ success: true, serverName });
            
            // Add a small delay between webhooks to avoid rate limits
            await new Promise(resolve => setTimeout(resolve, 500));
        } catch (error) {
            console.error(`❌ Error posting to server "${serverName}": ${error.message}`);
            results.push({ success: false, serverName, error: error.message });
        }
    }
    
    // If all failed, throw an error
    if (results.length > 0 && results.every(r => !r.success)) {
        throw new Error('Failed to post to all Discord webhooks');
    }
    
    return results;
}

async function fetchAnnouncements() {
    console.log(`📡 Fetching RSS feed from BRAC University...`);
    try {
        const response = await nodeFetch(RSS_JSON_URL, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36'
            }
        });
        
        if (!response.ok) {
            throw new Error(`❌ RSS feed error: ${response.status} ${response.statusText}`);
        }
        
        const data = await response.json();
        
        if (data.status !== 'ok' || !data.items || !Array.isArray(data.items)) {
            throw new Error('❌ Invalid response format from RSS feed');
        }
        
        console.log(`📋 Found ${data.items.length} items in RSS feed`);
        
        // Return all items from the RSS feed
        return data.items.map(item => ({
            id: item.guid || item.link,
            title: item.title,
            pubDate: item.pubDate,
            link: item.link,
            description: item.description
        }));
    } catch (error) {
        console.error('❌ Error fetching RSS feed:', error.message);
        throw error;
    }
}

// Add GitHub repository details
const GITHUB_REPO_OWNER = process.env.GITHUB_REPO_OWNER || 'zawad1804'; // Your GitHub username
const GITHUB_REPO_NAME = process.env.GITHUB_REPO_NAME || 'bracu-announcement-bot'; // Your repository name
const GITHUB_FILE_PATH = 'announcements.json'; // Path to file in repository

// Add this function to sync data to GitHub
async function syncToGitHub() {
  console.log('🔄 Attempting to sync announcements to GitHub...');
  
  if (!process.env.GITHUB_TOKEN) {
    console.log('⚠️ No GitHub token found in environment variables. Skipping sync to GitHub.');
    return false;
  }
  
  try {
    const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
    const content = fs.readFileSync(DB_FILE, 'utf8');
    
    // Try to get the current file (to get the SHA)
    let fileSha;
    try {
      const { data } = await octokit.repos.getContent({
        owner: GITHUB_REPO_OWNER,
        repo: GITHUB_REPO_NAME,
        path: GITHUB_FILE_PATH,
      });
      fileSha = data.sha;
      console.log(`📄 Found existing file in GitHub repository (SHA: ${fileSha.substring(0, 7)}...)`);
    } catch (error) {
      console.log('📄 File does not exist in GitHub repository yet, will create it');
    }
    
    // Prepare the commit data
    const commitData = {
      owner: GITHUB_REPO_OWNER,
      repo: GITHUB_REPO_NAME,
      path: GITHUB_FILE_PATH,
      message: `Update announcements database [${new Date().toISOString()}]`,
      content: Buffer.from(content).toString('base64'),
      committer: {
        name: 'BRAC University Announcement Bot',
        email: 'bot@example.com' // Use a valid email or your GitHub email
      }
    };
    
    // Add SHA if updating existing file
    if (fileSha) {
      commitData.sha = fileSha;
    }
    
    // Create or update the file
    const response = await octokit.repos.createOrUpdateFileContents(commitData);
    
    console.log(`✅ Successfully synced announcements to GitHub (commit: ${response.data.commit.sha.substring(0, 7)}...)`);
    return true;
  } catch (error) {
    console.error('❌ Error syncing to GitHub:', error.message);
    if (error.response) {
      console.error(`   Status: ${error.response.status}, Message: ${error.response.data.message}`);
    }
    return false;
  }
}

// Add a sync schedule function
let lastSyncTime = 0;
const SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000; // Default: once per day

async function syncIfNeeded() {
  const now = Date.now();
  if (now - lastSyncTime >= SYNC_INTERVAL_MS) {
    const success = await syncToGitHub();
    if (success) {
      lastSyncTime = now;
    }
  }
}

async function main() {
    try {
        const currentTime = new Date();
        const bdtOptions = { 
            timeZone: 'Asia/Dhaka', 
            hour12: true,
            year: 'numeric',
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        };
        const currentTimeBDT = currentTime.toLocaleString('en-US', bdtOptions);
        const nextCheckTime = new Date(currentTime.getTime() + CHECK_INTERVAL_MS);
        const nextCheckTimeBDT = nextCheckTime.toLocaleString('en-US', bdtOptions);
        
        console.log(`\n🚀 Starting BRAC University Announcement Bot at ${currentTimeBDT} (GMT+6)`);
        console.log(`⏱️  Next check scheduled for ${nextCheckTimeBDT} (GMT+6)`);
        
        const posted = loadPosted();
        const postedIds = new Set(posted.map(a => a.id));
        console.log(`📋 Loaded ${posted.length} previously posted announcements`);
        
        console.log(`🔍 Fetching announcements from BRAC University...`);
        const announcements = await fetchAnnouncements();
        
        if (announcements.length === 0) {
            console.log('❌ No announcements found in the RSS feed.');
            return;
        }
        console.log(`✅ Found ${announcements.length} announcements in total`);
        
        let newPosted = false;
        let newCount = 0;
        for (i=announcements.length-1;i>=0;i--) {
            const ann = announcements[i];
            if (!postedIds.has(ann.id)) {
                await postToDiscord(ann);
                posted.push({ 
                    id: ann.id, 
                    title: ann.title,
                    postedAt: new Date().toISOString() 
                });
                newPosted = true;
                newCount++;
                console.log(`📢 New announcement posted: "${ann.title}" [ID: ${ann.id}]`);
                
                // Add a small delay between posting to avoid rate limits
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }
        
        if (newPosted) {
            savePosted(posted);
            console.log(`💾 Updated database with ${newCount} new announcements`);
            
            // Sync to GitHub after saving new announcements
            await syncToGitHub();
        } else {
            console.log(`😴 No new announcements found since last check`);
            
            // Periodically sync even if no new announcements
            await syncIfNeeded();
        }
        
        console.log(`🔄 Bot running. Next check in ${CHECK_INTERVAL_MS/1000/60} minutes...`);
    } catch (error) {
        console.error('❌ Error in main function:', error);
    }
}

// Update the initial run message
// Run immediately once
console.log(`🔔 BRAC University Announcement Bot Initializing...`);
main();

// Then schedule to run at regular intervals
const currentTime = new Date();
const bdtOptions = { 
    timeZone: 'Asia/Dhaka', 
    hour12: true,
    hour: '2-digit',
    minute: '2-digit'
};
const currentTimeBDT = currentTime.toLocaleString('en-US', bdtOptions);
const nextCheckTime = new Date(currentTime.getTime() + CHECK_INTERVAL_MS);
const nextCheckTimeBDT = nextCheckTime.toLocaleString('en-US', bdtOptions);

console.log(`⏰ Current time: ${currentTimeBDT} (GMT+6) | Next check: ${nextCheckTimeBDT} (GMT+6)`);
setInterval(main, CHECK_INTERVAL_MS);

const http = require('http');
const PORT = process.env.PORT || 3000;

// Create a simple HTTP server
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(`
    <html>
      <head>
        <title>BRAC University Announcement Bot</title>
        <style>
          body { font-family: Arial, sans-serif; margin: 40px; line-height: 1.6; }
          h1 { color: #336ca6; }
          .container { max-width: 800px; margin: 0 auto; }
          .status { padding: 15px; background-color: #f5f5f5; border-radius: 5px; }
          .footer { margin-top: 30px; font-size: 0.8em; color: #666; }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>BRAC University Announcement Bot</h1>
          <div class="status">
            <p>✅ Bot is running</p>
            <p>Last check: ${new Date().toLocaleString('en-US', { 
              timeZone: 'Asia/Dhaka',
              hour12: true,
              year: 'numeric',
              month: 'short',
              day: 'numeric',
              hour: '2-digit',
              minute: '2-digit'
            })} (GMT+6)</p>
            <p>Check interval: ${CHECK_INTERVAL_MS/1000/60} minutes</p>
          </div>
          <div class="footer">
            <p>BRAC University Announcement Bot - Running on Render</p>
          </div>
        </div>
      </body>
    </html>
  `);
});

// Start the server
server.listen(PORT, () => {
  console.log(`🌐 Web server running on port ${PORT}`);
});

// Perform an initial sync when the bot starts
setTimeout(async () => {
  console.log('🔄 Performing initial GitHub sync...');
  await syncToGitHub();
}, 30000); // Wait 30 seconds after startup to ensure everything is initialized

// Schedule periodic GitHub sync
setInterval(async () => {
  console.log('⏰ Running scheduled GitHub sync...');
  await syncToGitHub();
}, SYNC_INTERVAL_MS);
