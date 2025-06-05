const puppeteer = require('puppeteer');
const cheerio = require('cheerio');
const fs = require('fs');

const WEBHOOK_URL = 'https://discord.com/api/webhooks/1379882838371078284/pDlJwJXuJ_6yKBX8hrW2Ic6yMDeW__9YpbWsvpG-DphyKFG_5GPm3nnlNunRNo69kJJE';
const DB_FILE = 'announcements.json';

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
    const content = `## ${announcement.heading}\n**Published On: ** ${announcement.publishDate}\n**Details: ** ${announcement.link}`;
    await fetch(WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content })
    });
}

async function fetchAnnouncements() {
    const url = 'https://www.bracu.ac.bd/news-archive/announcements';
    const browser = await puppeteer.launch({
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-blink-features=AutomationControlled'
        ]
    });
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36');
    await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });
    await page.goto(url, { waitUntil: 'networkidle2' });
    await page.waitForSelector('.view-content .views-row', { timeout: 20000 });
    const html = await page.content();
    await browser.close();

    const $ = cheerio.load(html);
    const announcements = [];

    $('.view-content .views-row').each((i, el) => {
        const article = $(el).find('article');
        const id = article.attr('id') ? article.attr('id').replace('node-', '') : null;
        const heading = article.find('h2.page-h1 a').text().trim();
        const link = article.find('h2.page-h1 a').attr('href');
        const fullLink = link ? `https://www.bracu.ac.bd${link}` : null;
        const publishDate = article.find('.date-display-single').text().trim();

        if (heading && id && fullLink && publishDate) {
            announcements.push({
                id,
                heading,
                publishDate,
                link: fullLink
            });
        }
    });

    return announcements;
}

async function main() {
    const posted = loadPosted();
    const postedIds = new Set(posted.map(a => a.id));
    const announcements = await fetchAnnouncements();

    let newPosted = false;
    for (const ann of announcements) {
        if (!postedIds.has(ann.id)) {
            await postToDiscord(ann);
            posted.push({ id: ann.id, heading: ann.heading });
            newPosted = true;
            console.log('Posted new announcement:', ann.heading, '[Announcement ID:', ann.id, ']');
        }
    }
    if (newPosted) savePosted(posted);
    else console.log('No new announcements.');
}

main();