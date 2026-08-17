require('dotenv').config();
const express = require('express');
const rateLimit = require('express-rate-limit');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static('.'));

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

// حافظه موقت لایه ضد تقلب
const clickVelocityTracker = new Map();
const browserFingerprintTracker = new Map();

async function startApp() {
    try {
        // ۱. مقداردهی اولیه SQLite
        const SQL = await initSqlJs();
        if (fs.existsSync(DB_FILE)) {
            const filebuffer = fs.readFileSync(DB_FILE);
            db = new SQL.Database(filebuffer);
        } else {
            db = new SQL.Database();
        }

        // ساخت جداول کامل دیتابیس
        db.run(`
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT UNIQUE NOT NULL,
                password TEXT NOT NULL,
                role TEXT NOT NULL,
                balance REAL DEFAULT 0
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
                invalidClicks INTEGER DEFAULT 0
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

        // ۲. اتصال به هدر هوش مصنوعی Gemini
        const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || 'dummy_key');

        // ۳. سیستم Rate Limiter لایه شبکه ضد تقلب
        const standardRateLimiter = rateLimit({
            windowMs: 60 * 1000,
            max: 15,
            handler: (req, res) => {
                res.status(429).json({ error: 'ترافیک مشکوک شناسایی شد.' });
            }
        });

        // ==========================================
        // ۴. احراز هویت (Auth API)
        // ==========================================
        app.post('/api/auth/register', (req, res) => {
            try {
                const { username, password, role } = req.body;
                db.run(`INSERT INTO users (username, password, role) VALUES (?, ?, ?)`, [username, password, role]);
                saveDatabase();
                res.status(201).json({ success: true, message: 'ثبت‌نام با موفقیت انجام شد.' });
            } catch (err) {
                res.status(400).json({ error: 'نام کاربری تکراری است.' });
            }
        });

        // ==========================================
        // ۵. پنل تبلیغ‌کننده (Advertiser Panel API)
        // ==========================================
        app.post('/api/advertiser/campaigns', (req, res) => {
            try {
                const { advertiserId, title, bannerUrl, targetUrl, pricingType, bidAmount, budget, targetDevice } = req.body;
                db.run(
                    `INSERT INTO campaigns (advertiserId, title, bannerUrl, targetUrl, pricingType, bidAmount, budget, targetDevice, status) 
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
                    [advertiserId, title, bannerUrl, targetUrl, pricingType || 'CPC', bidAmount || 1, budget || 100, targetDevice || 'all']
                );
                saveDatabase();
                res.status(201).json({ success: true, message: 'کمپین ایجاد شد و در انتظار تایید است.' });
            } catch (err) {
                res.status(500).json({ error: 'خطا در ایجاد کمپین.' });
            }
        });

        // ==========================================
        // ۶. هسته هوشمند AD SERVER (وزن‌دهی Bidding و سرو تبلیغ)
        // ==========================================
        app.get('/ad/serve', (req, res) => {
            try {
                const clientDevice = req.headers['sec-ch-ua-mobile'] === '?1' ? 'mobile' : 'desktop';

                const stmt = db.prepare(`SELECT * FROM campaigns WHERE status = 'active' AND spent < budget`);
                const activeCampaigns = [];
                while (stmt.step()) activeCampaigns.push(stmt.getAsObject());
                stmt.free();

                if (!activeCampaigns.length) {
                    return res.status(200).json({ success: false, message: 'هیچ تبلیغ فعالی وجود ندارد.' });
                }

                // ۱. هدف‌گیری دستگاه (Device Targeting)
                const eligibleCampaigns = activeCampaigns.filter(camp => 
                    camp.targetDevice === 'all' || camp.targetDevice === clientDevice
                );
                const targetPool = eligibleCampaigns.length > 0 ? eligibleCampaigns : activeCampaigns;

                // ۲. الگوریتم وزن‌دهی انتخابی بر اساس Bidding
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

                // ۳. محاسبه نمایش و هزینه CPM
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
                res.status(500).json({ error: 'خطا در سرویس‌دهی تبلیغ.' });
            }
        });

        // ==========================================
        // ۷. ثبت کلیک + لایه‌های ۴ گانه ضد تقلب
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
                    return res.status(404).json({ error: 'کمپین یافت نشد.' });
                }
                const campaign = stmt.getAsObject();
                stmt.free();

                if (campaign.status !== 'active') {
                    return res.status(400).json({ error: 'کمپین فعال نیست.' });
                }

                // لایه ۱: فیلتر ربات‌ها و مرورگرهای Headless
                if (!userAgent || /bot|crawl|spider|slurp|headless|selenium|puppeteer/i.test(userAgent)) {
                    db.run(`UPDATE campaigns SET invalidClicks = invalidClicks + 1 WHERE id = ?`, [campaignId]);
                    db.run(`INSERT INTO fraud_logs (campaignId, ip, reason) VALUES (?, ?, ?)`, [campaignId, clientIp, 'Automated Bot Detected']);
                    saveDatabase();
                    return res.status(403).json({ error: 'درخواست غیرمجاز شناسایی شد.' });
                }

                // لایه ۲: سنجش سرعت کلیک (Velocity Check)
                const ipKey = `${campaignId}_${clientIp}`;
                if (clickVelocityTracker.has(ipKey)) {
                    const lastClickTime = clickVelocityTracker.get(ipKey);
                    if (now - lastClickTime < 10000) { // کلیک زیر ۱۰ ثانیه
                        db.run(`UPDATE campaigns SET invalidClicks = invalidClicks + 1 WHERE id = ?`, [campaignId]);
                        db.run(`INSERT INTO fraud_logs (campaignId, ip, reason) VALUES (?, ?, ?)`, [campaignId, clientIp, 'High velocity click']);
                        saveDatabase();
                        return res.status(429).json({ error: 'کلیک‌های متوالی سریع مجاز نیست.' });
                    }
                }
                clickVelocityTracker.set(ipKey, now);

                // لایه ۳: شناسایی اثر انگشت مرورگر (Fingerprint Check)
                if (fingerprint) {
                    const fpKey = `${campaignId}_${fingerprint}`;
                    if (browserFingerprintTracker.has(fpKey)) {
                        db.run(`UPDATE campaigns SET invalidClicks = invalidClicks + 1 WHERE id = ?`, [campaignId]);
                        db.run(`INSERT INTO fraud_logs (campaignId, ip, reason) VALUES (?, ?, ?)`, [campaignId, clientIp, 'Duplicate click from same fingerprint']);
                        saveDatabase();
                        return res.status(400).json({ error: 'شما قبلاً روی این کمپین کلیک کرده‌اید.' });
                    }
                    browserFingerprintTracker.set(fpKey, true);
                }

                // لایه ۴: ثبت کلیک معتبر و محاسبه CPC
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
                res.status(500).json({ error: 'خطای سرور.' });
            }
        });

        // ==========================================
        // ۸. پنل مدیریت و لاگ‌های تقلب (Admin Panel)
        // ==========================================
        app.post('/api/admin/campaigns/:id/status', (req, res) => {
            try {
                const { status } = req.body;
                db.run(`UPDATE campaigns SET status = ? WHERE id = ?`, [status, req.params.id]);
                saveDatabase();
                res.json({ success: true, message: `وضعیت کمپین به ${status} تغییر یافت.` });
            } catch (err) {
                res.status(500).json({ error: 'خطا در به‌روزرسانی وضعیت کمپین.' });
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
                res.status(500).json({ error: 'خطا در دریافت لاگ‌ها.' });
            }
        });

        // ==========================================
        // ۹. هوش مصنوعی: تولید متن (Gemini) و بنر (SVG Generator)
        // ==========================================
        app.post('/api/ai/generate-text', async (req, res) => {
            try {
                const { topic, tone } = req.body;
                if (!topic) return res.status(400).json({ error: 'موضوع تبلیغ را وارد کنید.' });

                const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
                const prompt = `یک متن تبلیغاتی کوتاه، جذاب و حداکثر ۱۰ کلمه‌ای برای موضوع "${topic}" با لحن "${tone || 'جذاب'}" بنویس. فقط خود متن را بفرست.`;
                
                const result = await model.generateContent(prompt);
                const response = await result.response;
                res.json({ success: true, text: response.text().trim() });
            } catch (error) {
                res.status(500).json({ error: 'خطا در ارتباط با هوش مصنوعی Gemini.' });
            }
        });

        app.post('/api/ai/generate-banner', (req, res) => {
            try {
                const { title, bgColor, textColor } = req.body;
                const bg = bgColor || '#2563eb';
                const textCol = textColor || '#ffffff';
                const text = title || 'عنوان تبلیغ شما';

                const svg = `
                <svg xmlns="http://www.w3.org/2000/svg" width="300" height="250" viewBox="0 0 300 250">
                    <rect width="100%" height="100%" fill="${bg}" rx="12"/>
                    <circle cx="150" cy="125" r="100" fill="white" opacity="0.1"/>
                    <text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" fill="${textCol}" font-family="Tahoma, Arial" font-size="18" font-weight="bold">
                        ${text}
                    </text>
                </svg>`.trim();

                const base64Svg = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
                res.json({ success: true, bannerUrl: base64Svg });
            } catch (err) {
                res.status(500).json({ error: 'خطا در ساخت بنر.' });
            }
        });

        // ۱۰. راه‌اندازی سرور
        const PORT = process.env.PORT || 3000;
        app.listen(PORT, () => {
            console.log(`Ad Network Server is running on http://localhost:${PORT}`);
        });

    } catch (err) {
        console.error('Error starting server:', err);
    }
}

startApp();

