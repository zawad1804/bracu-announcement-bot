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

const DB_FILE = process.env.DB_FILE || 'bracu-announcements.json';
console.log(`📁 Using database file: ${DB_FILE}`);

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

// Update the loadPosted function with better error handling
function loadPosted() {
    console.log(`📂 Checking for database file at: ${DB_FILE}`);
    if (fs.existsSync(DB_FILE)) {
        try {
            const data = fs.readFileSync(DB_FILE, 'utf8');
            console.log(`📥 Successfully loaded database file (${data.length} bytes)`);
            return JSON.parse(data);
        } catch (error) {
            console.error(`❌ Error reading database file: ${error.message}`);
            console.log(`🔧 Creating new empty database`);
            const emptyData = [];
            fs.writeFileSync(DB_FILE, JSON.stringify(emptyData, null, 2));
            return emptyData;
        }
    } else {
        console.log(`📝 Database file not found, creating new empty database`);
        const emptyData = [];
        fs.writeFileSync(DB_FILE, JSON.stringify(emptyData, null, 2));
        return emptyData;
    }
}

function savePosted(posted) {
    fs.writeFileSync(DB_FILE, JSON.stringify(posted, null, 2));
}

// Update the postToDiscord function to handle timeouts better with retries
async function postToDiscord(announcement) {
    console.log(`📤 Attempting to post to ${WEBHOOK_URLS.length} Discord server(s): "${announcement.title}"`);
    
    // Debug: Print webhook URLs (partially masked for security)
    WEBHOOK_URLS.forEach((url, i) => {
        const maskedUrl = url.substring(0, 30) + '...' + url.substring(url.length - 10);
        console.log(`🔹 Webhook #${i+1} (${WEBHOOK_NAMES[i]}): ${maskedUrl}`);
    });
    
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
    
    // Post to each webhook with better timeout handling
    for (let i = 0; i < WEBHOOK_URLS.length; i++) {
        const webhookUrl = WEBHOOK_URLS[i];
        const serverName = WEBHOOK_NAMES[i] || `Server ${i + 1}`;
        
        // Retry the entire webhook posting process up to 3 times with increasing timeouts
        let success = false;
        let lastError = null;
        
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                console.log(`🔄 [Attempt ${attempt}/3] Processing webhook for server: ${serverName}`);
                
                // Extract webhook ID and token from URL
                let parts;
                try {
                    parts = getWebhookParts(webhookUrl);
                    console.log(`✅ Successfully parsed webhook URL for ${serverName}`);
                } catch (parseError) {
                    console.error(`❌ Invalid webhook URL format for ${serverName}: ${parseError.message}`);
                    lastError = parseError;
                    break; // No need to retry if URL is invalid
                }
                
                // Create webhook client
                console.log(`🔄 Creating webhook client for ${serverName}...`);
                const webhookClient = new WebhookClient({ 
                    id: parts.id, 
                    token: parts.token 
                });
                
                // Send the embed through the webhook with per-attempt timeout
                console.log(`🔄 Sending message to ${serverName}...`);
                
                // Increase timeout for each retry
                const timeoutMs = 10000 * attempt; // 10s, 20s, 30s
                
                // Create a promise that rejects after timeout
                const timeoutPromise = new Promise((_, reject) => 
                    setTimeout(() => reject(new Error(`Discord webhook request timed out after ${timeoutMs/1000} seconds`)), timeoutMs)
                );
                
                // Create the webhook send promise
                const webhookPromise = webhookClient.send({
                    embeds: [embed]
                });
                
                // Race the webhook request against the timeout
                await Promise.race([webhookPromise, timeoutPromise]);
                
                console.log(`✅ Successfully posted to Discord server: ${serverName}`);
                results.push({ success: true, serverName });
                success = true;
                break; // Exit the retry loop on success
            } catch (error) {
                lastError = error;
                console.error(`❌ [Attempt ${attempt}/3] Error posting to server "${serverName}": ${error.message}`);
                
                if (attempt < 3) {
                    // Calculate backoff delay with exponential increase
                    const backoffDelay = 2000 * Math.pow(2, attempt - 1); // 2s, 4s, 8s
                    console.log(`⏱️ Retrying in ${backoffDelay/1000} seconds...`);
                    await new Promise(resolve => setTimeout(resolve, backoffDelay));
                } else {
                    console.error(`❌ All 3 attempts failed for server "${serverName}"`);
                }
            }
        }
        
        // If all retries failed, add the failure to results
        if (!success) {
            results.push({ 
                success: false, 
                serverName, 
                error: lastError ? lastError.message : 'Unknown error' 
            });
        }
        
        // Add a small delay between different webhooks to avoid rate limits
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    // Summary of results
    const successCount = results.filter(r => r.success).length;
    console.log(`📊 Discord posting summary: ${successCount}/${results.length} successful`);
    
    // If all failed, throw an error
    if (results.length > 0 && results.every(r => !r.success)) {
        throw new Error('Failed to post to all Discord webhooks after multiple retries');
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
const GITHUB_FILE_PATH = 'bracu-announcements.json'; // Path to file in repository

// Update the syncToGitHub function to handle missing files
async function syncToGitHub() {
  console.log('🔄 Attempting to sync announcements to GitHub...');
  
  if (!process.env.GITHUB_TOKEN) {
    console.log('⚠️ No GitHub token found in environment variables. Skipping sync to GitHub.');
    return false;
  }
  
  try {
    // Check if the file exists first
    if (!fs.existsSync(DB_FILE)) {
      console.log(`⚠️ Database file not found (${DB_FILE}). Creating empty database before syncing.`);
      fs.writeFileSync(DB_FILE, JSON.stringify([], null, 2));
    }
    
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
        const successfulAnnouncements = []; // Track successfully posted announcements
        
        for (let i=announcements.length-1; i>=0; i--) {
            const ann = announcements[i];
            if (!postedIds.has(ann.id)) {
                try {
                    // Make Discord posting with a timeout
                    const postingPromise = postToDiscord(ann);
                    const timeoutPromise = new Promise((_, reject) => 
                        setTimeout(() => reject(new Error('Discord posting timed out after 30 seconds')), 30000)
                    );
                    
                    // Try to post to Discord
                    let discordSuccess = false;
                    try {
                        const postingResult = await Promise.race([postingPromise, timeoutPromise]);
                        
                        // Check if posting was successful to at least one server
                        if (postingResult && postingResult.some(r => r.success)) {
                            discordSuccess = true;
                            console.log(`✅ Successfully posted to at least one Discord server`);
                        } else {
                            console.log(`❌ Failed to post to any Discord servers`);
                        }
                    } catch (postError) {
                        console.error(`⚠️ Error posting to Discord: ${postError.message}`);
                        discordSuccess = false;
                    }
                    
                    // Only save announcements that were successfully posted to Discord
                    if (discordSuccess) {
                        successfulAnnouncements.push({
                            id: ann.id, 
                            title: ann.title,
                            postedAt: new Date().toISOString()
                        });
                        
                        newPosted = true;
                        newCount++;
                        console.log(`📢 New announcement successfully posted and will be saved: "${ann.title}" [ID: ${ann.id}]`);
                    } else {
                        console.log(`⚠️ Announcement not saved due to Discord posting failure: "${ann.title}" [ID: ${ann.id}]`);
                    }
                    
                    // Add a small delay between posting to avoid rate limits
                    await new Promise(resolve => setTimeout(resolve, 1000));
                } catch (error) {
                    console.error(`❌ Error processing announcement: ${error.message}`);
                }
            }
        }
        
        // Only save announcements that were successfully posted
        if (successfulAnnouncements.length > 0) {
            // Add all successful announcements to the posted list
            posted.push(...successfulAnnouncements);
            
            // Save to JSON file
            savePosted(posted);
            console.log(`💾 Updated database with ${successfulAnnouncements.length} new announcements`);
            
            // Sync to GitHub after saving new announcements
            await syncToGitHub();
        } else if (newPosted) {
            console.log(`⚠️ No announcements were saved because none could be posted to Discord successfully`);
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
