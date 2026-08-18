require('dotenv').config();
const express = require('express');
const rateLimit = require('express-rate-limit');
const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));


const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

let db;
const DB_FILE = path.join(__dirname, 'database.sqlite');

// تابع ذخیره‌سازی امن دیتابیس بدون کرش
function saveDatabase() {
    try {
        if (db) {
            const data = db.export();
            const buffer = Buffer.from(data);
            fs.writeFileSync(DB_FILE, buffer);
        }
    } catch (e) {
        console.error('Database save error:', e);
    }
}

// حافظه‌های موقت لایه ضد تقلب
const clickVelocityTracker = new Map();
const browserFingerprintTracker = new Map();

async function startApp() {
    try {
        // ۱. راه‌اندازی و مقداردهی اولیه SQLite
        const SQL = await initSqlJs();
        if (fs.existsSync(DB_FILE)) {
            const filebuffer = fs.readFileSync(DB_FILE);
            db = new SQL.Database(filebuffer);
        } else {
            db = new SQL.Database();
        }

        // ایجاد جداول ساختاریافته کامل
        db.run(`
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT UNIQUE NOT NULL,
                password TEXT NOT NULL,
                role TEXT NOT NULL,
                balance REAL DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS campaigns (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                advertiserId INTEGER,
                title TEXT,
                bannerUrl TEXT,
                targetUrl TEXT,
                pricingType TEXT DEFAULT 'CPC',
                bidAmount REAL DEFAULT 1,
                budget REAL,
                spent REAL DEFAULT 0,
                status TEXT DEFAULT 'pending',
                targetDevice TEXT DEFAULT 'all',
                clicks INTEGER DEFAULT 0,
                impressions INTEGER DEFAULT 0,
                invalidClicks INTEGER DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS fraud_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                campaignId INTEGER,
                ip TEXT,
                reason TEXT,
                timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
            );
        `);
        saveDatabase();

        // ۲. لایه محدودسازی شبکه (Rate Limiter)
        const standardRateLimiter = rateLimit({
            windowMs: 60 * 1000,
            max: 20,
            handler: (req, res) => {
                res.status(429).json({ success: false, error: 'ترافیک مشکوک یا درخواست بیش از حد مجاز شناسایی شد.' });
            }
        });

        // ==========================================
        // ۳. بخش احراز هویت (Auth API)
        // ==========================================
        app.post('/api/auth/register', (req, res) => {
            try {
                const { username, password, role } = req.body;
                db.run(`INSERT INTO users (username, password, role) VALUES (?, ?, ?)`, [username, password, role || 'advertiser']);
                saveDatabase();
                res.status(201).json({ success: true, message: 'ثبت‌نام با موفقیت انجام شد.' });
            } catch (err) {
                res.status(400).json({ success: false, error: 'نام کاربری تکراری است یا اطلاعات نامعتبر است.' });
            }
        });

        // ==========================================
        // ۴. بخش پنل تبلیغ‌کننده و کمپین‌ها (Advertiser API)
        // ==========================================
        app.post('/api/advertiser/campaigns', (req, res) => {
            try {
                const { advertiserId, title, bannerUrl, targetUrl, pricingType, bidAmount, budget, targetDevice } = req.body;
                db.run(
                    `INSERT INTO campaigns (advertiserId, title, bannerUrl, targetUrl, pricingType, bidAmount, budget, targetDevice, status) 
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
                    [advertiserId || 1, title, bannerUrl, targetUrl, pricingType || 'CPC', bidAmount || 1, budget || 100, targetDevice || 'all']
                );
                saveDatabase();
                res.status(201).json({ success: true, message: 'کمپین ایجاد شد و در انتظار تایید مدیریت است.' });
            } catch (err) {
                res.status(500).json({ success: false, error: 'خطا در ایجاد کمپین.' });
            }
        });

        // ==========================================
        // ۵. هسته هوشمند سرو تبلیغ (Ad Server & Bidding)
        // ==========================================
        app.get('/ad/serve', (req, res) => {
            try {
                const clientDevice = req.headers['sec-ch-ua-mobile'] === '?1' ? 'mobile' : 'desktop';

                const stmt = db.prepare(`SELECT * FROM campaigns WHERE status = 'active' AND spent < budget`);
                const activeCampaigns = [];
                while (stmt.step()) activeCampaigns.push(stmt.getAsObject());
                stmt.free();

                if (!activeCampaigns.length) {
                    return res.status(200).json({ success: false, message: 'هیچ تبلیغ فعالی در سیستم وجود ندارد.' });
                }

                // هدف‌گیری دستگاه (Device Targeting)
                const eligibleCampaigns = activeCampaigns.filter(camp => 
                    camp.targetDevice === 'all' || camp.targetDevice === clientDevice
                );
                const targetPool = eligibleCampaigns.length > 0 ? eligibleCampaigns : activeCampaigns;

                // الگوریتم وزن‌دهی مبتنی بر پیشنهاد قیمت (Bidding Weight)
                let totalWeight = targetPool.reduce((sum, camp) => sum + (camp.bidAmount || 1), 0);
                let randomWeight = Math.random() * totalWeight;
                let selectedCampaign = targetPool[0];

                for (let camp of targetPool) {
                    randomWeight -= (camp.bidAmount || 1);
                    if (randomWeight <= 0) {
                        selectedCampaign = camp;
                        break;
                    }
                }

                // محاسبه نمایش (Impression) و هزینه CPM
                let newImpressions = (selectedCampaign.impressions || 0) + 1;
                let newSpent = selectedCampaign.spent || 0;

                if (selectedCampaign.pricingType === 'CPM') {
                    newSpent += (selectedCampaign.bidAmount / 1000);
                }

                let newStatus = newSpent >= selectedCampaign.budget ? 'exhausted' : selectedCampaign.status;

                db.run(
                    `UPDATE campaigns SET impressions = ?, spent = ?, status = ? WHERE id = ?`,
                    [newImpressions, newSpent, newStatus, selectedCampaign.id]
                );
                saveDatabase();

                res.json({
                    success: true,
                    campaignId: selectedCampaign.id,
                    title: selectedCampaign.title,
                    bannerUrl: selectedCampaign.bannerUrl,
                    targetUrl: selectedCampaign.targetUrl
                });
            } catch (err) {
                res.status(500).json({ success: false, error: 'خطا در سرویس‌دهی تبلیغ.' });
            }
        });

        // ==========================================
        // ۶. ثبت کلیک با سیستم ۴ لایه ضد تقلب پیشرفته (Anti-Fraud)
        // ==========================================
        app.post('/campaigns/:id/click', standardRateLimiter, (req, res) => {
            try {
                const campaignId = req.params.id;
                const clientIp = req.ip || req.headers['x-forwarded-for'] || '127.0.0.1';
                const { fingerprint, userAgent } = req.body;
                const now = Date.now();

                const stmt = db.prepare(`SELECT * FROM campaigns WHERE id = ?`);
                stmt.bind([campaignId]);
                if (!stmt.step()) {
                    stmt.free();
                    return res.status(404).json({ success: false, error: 'کمپین مورد نظر یافت نشد.' });
                }
                const campaign = stmt.getAsObject();
                stmt.free();

                if (campaign.status !== 'active') {
                    return res.status(400).json({ success: false, error: 'کمپین فعال نیست.' });
                }

                // لایه ۱: فیلتر ربات‌ها و مرورگرهای خودکار (Headless/Bots)
                if (!userAgent || /bot|crawl|spider|slurp|headless|selenium|puppeteer/i.test(userAgent)) {
                    db.run(`UPDATE campaigns SET invalidClicks = invalidClicks + 1 WHERE id = ?`, [campaignId]);
                    db.run(`INSERT INTO fraud_logs (campaignId, ip, reason) VALUES (?, ?, ?)`, [campaignId, clientIp, 'شناسایی ربات خودکار']);
                    saveDatabase();
                    return res.status(403).json({ success: false, error: 'دسترسی غیرمجاز: ربات شناسایی شد.' });
                }

                // لایه ۲: سنجش سرعت کلیک متوالی (Velocity Check)
                const ipKey = `${campaignId}_${clientIp}`;
                if (clickVelocityTracker.has(ipKey)) {
                    const lastClickTime = clickVelocityTracker.get(ipKey);
                    if (now - lastClickTime < 10000) { // محدودیت زمانی ۱۰ ثانیه
                        db.run(`UPDATE campaigns SET invalidClicks = invalidClicks + 1 WHERE id = ?`, [campaignId]);
                        db.run(`INSERT INTO fraud_logs (campaignId, ip, reason) VALUES (?, ?, ?)`, [campaignId, clientIp, 'کلیک‌های سریع متوالی']);
                        saveDatabase();
                        return res.status(429).json({ success: false, error: 'کلیک‌های متوالی سریع مجاز نیست.' });
                    }
                }
                clickVelocityTracker.set(ipKey, now);

                // لایه ۳: بررسی اثر انگشت مرورگر (Browser Fingerprint)
                if (fingerprint) {
                    const fpKey = `${campaignId}_${fingerprint}`;
                    if (browserFingerprintTracker.has(fpKey)) {
                        db.run(`UPDATE campaigns SET invalidClicks = invalidClicks + 1 WHERE id = ?`, [campaignId]);
                        db.run(`INSERT INTO fraud_logs (campaignId, ip, reason) VALUES (?, ?, ?)`, [campaignId, clientIp, 'کلیک تکراری با اثر انگشت مشابه']);
                        saveDatabase();
                        return res.status(400).json({ success: false, error: 'شما قبلاً روی این تبلیغ کلیک کرده‌اید.' });
                    }
                    browserFingerprintTracker.set(fpKey, true);
                }

                // لایه ۴: ثبت کلیک معتبر نهایی و کسر هزینه CPC
                let newClicks = (campaign.clicks || 0) + 1;
                let newSpent = campaign.spent || 0;

                if (campaign.pricingType === 'CPC') {
                    newSpent += (campaign.bidAmount || 1);
                }

                let newStatus = newSpent >= campaign.budget ? 'exhausted' : campaign.status;

                db.run(
                    `UPDATE campaigns SET clicks = ?, spent = ?, status = ? WHERE id = ?`,
                    [newClicks, newSpent, newStatus, campaignId]
                );
                saveDatabase();

                res.json({ success: true, message: 'کلیک معتبر تایید شد.', targetUrl: campaign.targetUrl });
            } catch (err) {
                res.status(500).json({ success: false, error: 'خطای سرور در پردازش کلیک.' });
            }
        });

        // ==========================================
        // ۷. پنل مدیریت پیشرفته و گزارش‌گیری (Admin Panel & Reports)
        // ==========================================
        app.get('/api/admin/reports', (req, res) => {
            try {
                const totalCampaigns = db.exec(`SELECT COUNT(*) as count FROM campaigns`)[0]?.values[0][0] || 0;
                const totalClicks = db.exec(`SELECT SUM(clicks) as sum FROM campaigns`)[0]?.values[0][0] || 0;
                const totalSpent = db.exec(`SELECT SUM(spent) as sum FROM campaigns`)[0]?.values[0][0] || 0;
                const totalInvalid = db.exec(`SELECT SUM(invalidClicks) as sum FROM campaigns`)[0]?.values[0][0] || 0;

                res.json({
                    success: true,
                    stats: { totalCampaigns, totalClicks, totalSpent, totalInvalid }
                });
            } catch (err) {
                res.status(500).json({ success: false, error: 'خطا در دریافت گزارشات آماری.' });
            }
        });

        app.post('/api/admin/campaigns/:id/status', (req, res) => {
            try {
                const { status } = req.body; // active, paused, rejected
                db.run(`UPDATE campaigns SET status = ? WHERE id = ?`, [status, req.params.id]);
                saveDatabase();
                res.json({ success: true, message: `وضعیت کمپین به ${status} به‌روز شد.` });
            } catch (err) {
                res.status(500).json({ success: false, error: 'خطا در تغییر وضعیت کمپین.' });
            }
        });

        app.get('/api/admin/fraud-logs', (req, res) => {
            try {
                const stmt = db.prepare(`SELECT * FROM fraud_logs ORDER BY timestamp DESC LIMIT 50`);
                const logs = [];
                while (stmt.step()) logs.push(stmt.getAsObject());
                stmt.free();
                res.json({ success: true, logs });
            } catch (err) {
                res.status(500).json({ success: false, error: 'خطا در دریافت لاگ‌های تقلب.' });
            }
        });

        // ==========================================
        // ۸. هوش مصنوعی گروک (Groq AI) برای تولید متن و بنرساز SVG
        // ==========================================
        async function generateTextWithGroq(topic, tone) {
            const apiKey = process.env.GROQ_API_KEY;
            if (!apiKey) throw new Error('کلید API گروک تنظیم نشده است.');

            const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${apiKey}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    model: "openai/gpt-oss-20b",
                    messages: [
                        { role: "system", content: "You are a professional marketing and advertising copywriter." },
                        { role: "user", content: `Write a short and catchy advertising text for the topic "${topic}" with a "${tone || 'attractive'}" tone.` }
                    ],
                    temperature: 0.7
                })
            });

            const data = await response.json();
            if (!data.choices || data.choices.length === 0) {
                throw new Error(data.error?.message || 'خطا در دریافت پاسخ از هوش مصنوعی');
            }
            return data.choices[0].message.content.trim();
        }

        app.post('/api/ai/generate-text', async (req, res) => {
            try {
                const { topic, tone } = req.body;
                const adText = await generateTextWithGroq(topic || 'تخفیف ویژه', tone || 'جذاب');
                res.json({ success: true, ad: adText });
            } catch (err) {
                console.error('AI Text Error:', err);
                res.status(500).json({ success: false, error: err.message });
            }
        });

        app.post('/api/ai/generate-smart-banner', async (req, res) => {
            try {
                const { title, subtitle, theme, size } = req.body;
                
                let width = 300, height = 250;
                if (size === '728x90') { width = 728; height = 90; }
                else if (size === '400x400') { width = 400; height = 400; }
                else if (size === '1200x628') { width = 1200; height = 628; }

                // تعیین پالت‌های رنگی جذاب بر اساس تم انتخابی مشتری
                let col1 = '#2563eb', col2 = '#7c3aed', accentCol = '#f59e0b';
                if (theme === 'dark-neon') { col1 = '#0f172a'; col2 = '#1e1b4b'; accentCol = '#38bdf8'; }
                else if (theme === 'sunset') { col1 = '#f97316'; col2 = '#db2777'; accentCol = '#fde047'; }
                else if (theme === 'emerald') { col1 = '#065f46'; col2 = '#047857'; accentCol = '#34d399'; }

                const svg = `
                <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
                    <defs>
                        <linearGradient id="bgGrad" x1="0%" y1="0%" x2="100%" y2="100%">
                            <stop offset="0%" stop-color="${col1}" />
                            <stop offset="100%" stop-color="${col2}" />
                        </linearGradient>
                        <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
                            <feDropShadow dx="2" dy="4" stdDeviation="4" flood-color="#000" flood-opacity="0.3"/>
                        </filter>
                    </defs>
                    
                    <rect width="100%" height="100%" fill="url(#bgGrad)" rx="20"/>
                    
                    <circle cx="${width * 0.9}" cy="${height * 0.15}" r="${width * 0.25}" fill="${accentCol}" opacity="0.15"/>
                    <circle cx="${width * 0.1}" cy="${height * 0.85}" r="${width * 0.3}" fill="#ffffff" opacity="0.05"/>
                    <path d="M 0,${height * 0.7} Q ${width * 0.5},${height} ${width},${height * 0.6} L ${width},${height} L 0,${height} Z" fill="#000000" opacity="0.15"/>

                    <text x="50%" y="${subtitle ? '40%' : '50%'}" dominant-baseline="middle" text-anchor="middle" fill="#ffffff" font-family="Tahoma, Arial, sans-serif" font-size="${width > 600 ? 36 : (width > 350 ? 22 : 18)}" font-weight="bold" filter="url(#shadow)">
                        ${title || 'بنر تبلیغاتی هوشمند'}
                    </text>
                    
                    ${subtitle ? `
                    <text x="50%" y="62%" dominant-baseline="middle" text-anchor="middle" fill="${accentCol}" font-family="Tahoma, Arial, sans-serif" font-size="${width > 600 ? 20 : (width > 350 ? 14 : 11)}" font-weight="600">
                        ${subtitle}
                    </text>` : ''}

                    <g transform="translate(${width / 2 - 70}, ${height - 55})">
                        <rect width="140" height="36" rx="18" fill="${accentCol}" filter="url(#shadow)"/>
                        <text x="70" y="23" dominant-baseline="middle" text-anchor="middle" fill="#0f172a" font-family="Tahoma, Arial, sans-serif" font-size="13" font-weight="bold">
                            همین حالا خرید کنید
                        </text>
                    </g>
                </svg>`.trim();

                const bannerUrl = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
                res.json({ success: true, bannerUrl });
            } catch (err) {
                res.status(500).json({ success: false, error: 'خطا در ساخت بنر هوشمند.' });
            }
        });

        const PORT = process.env.PORT || 3000;
        app.listen(PORT, () => {
            console.log(`Smart AI Ad Network & Banner Studio running on http://localhost:${PORT}`);
        });

    } catch (err) {
        console.error('Server error:', err);
    }
}

startApp();
