require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const rateLimit = require('express-rate-limit');
const { GoogleGenerativeAI } = require('@google/generative-ai');


const app = express();
app.use(express.json());
app.use(express.static('.'));

// مقداردهی اولیه ابزار جمینی
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// اتصال به دیتابیس MongoDB Atlas
mongoose.connect(process.env.MONGO_URI || 'mongodb+srv://jasemelahi11_db_user:13691369Aa@ac-xxxx.mongodb.net/?retryWrites=true&w=majority')
  .then(() => console.log('Connected to MongoDB Atlas successfully!'))
  .catch((err) => console.error('MongoDB connection error:', err));

// ==========================================
// ۲. مدل‌های دیتابیس (Database Schemas)
// ==========================================

// مدل کاربر (تبلیغ‌کننده، ناشر، ادمین)
const userSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    password: { type: String, required: true }, // در پروژه واقعی باید هش شود
    role: { type: String, enum: ['advertiser', 'publisher', 'admin'], required: true },
    balance: { type: Number, default: 0 } // موجودی کیف پول
});
const User = mongoose.model('User', userSchema);

// مدل کمپین (مخصوص تبلیغ‌کنندگان)
const campaignSchema = new mongoose.Schema({
    advertiserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    title: String,
    bannerUrl: String,       
    targetUrl: String,       
    pricingType: { type: String, enum: ['CPC', 'CPM'], default: 'CPC' }, 
    bidAmount: { type: Number, default: 1 }, 
    budget: Number,          
    spent: { type: Number, default: 0 }, 
    status: { type: String, default: 'pending' }, // pending (در انتظار تایید ادمین), active, paused, exhausted
    targetDevice: { type: String, default: 'all' }, 
    clicks: { type: Number, default: 0 },
    impressions: { type: Number, default: 0 }, 
    invalidClicks: { type: Number, default: 0 },
    fraudLogs: [{
        ip: String,
        reason: String,
        timestamp: { type: Date, default: Date.now }
    }]
});
const Campaign = mongoose.model('Campaign', campaignSchema);

// حافظه‌های موقت امنیتی
const clickVelocityTracker = new Map();
const browserFingerprintTracker = new Map();

const standardRateLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 15,
    standardHeaders: true,
    legacyHeaders: false,
    handler: async (req, res) => {
        const campaignId = req.params.id;
        if (campaignId && mongoose.isValidObjectId(campaignId)) {
            await Campaign.findByIdAndUpdate(campaignId, { 
                $inc: { invalidClicks: 1 },
                $push: { fraudLogs: { ip: req.ip, reason: 'Rate limit exceeded (IP Flood)' } }
            });
        }
        res.status(429).json({ error: 'ترافیک مشکوک شناسایی شد.' });
    }
});


// ==========================================
// ۳. بخش احراز هویت (Auth API - ثبت‌نام و ورود)
// ==========================================
app.post('/api/auth/register', async (req, res) => {
    try {
        const { username, password, role } = req.body;
        const newUser = new User({ username, password, role });
        await newUser.save();
        res.status(201).json({ success: true, message: 'کاربر با موفقیت ثبت‌نام شد.', userId: newUser._id });
    } catch (err) {
        res.status(400).json({ error: 'خطا در ثبت‌نام. ممکن است نام کاربری تکراری باشد.' });
    }
});

app.post('/api/auth/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        const user = await User.findOne({ username, password });
        if (!user) {
            return res.status(401).json({ error: 'نام کاربری یا رمز عبور اشتباه است.' });
        }
        res.json({ success: true, message: 'ورود موفقیت‌آمیز', role: user.role, userId: user._id });
    } catch (err) {
        res.status(500).json({ error: 'خطای سرور' });
    }
});


// ==========================================
// ۴. بخش پنل تبلیغ‌کننده (Advertiser Panel API)
// ==========================================
// ایجاد کمپین جدید توسط تبلیغ‌کننده
app.post('/api/advertiser/campaigns', async (req, res) => {
    try {
        const { advertiserId, title, bannerUrl, targetUrl, pricingType, bidAmount, budget, targetDevice } = req.body;
        
        const newCampaign = new Campaign({
            advertiserId,
            title,
            bannerUrl,
            targetUrl,
            pricingType,
            bidAmount,
            budget,
            targetDevice,
            status: 'pending' // نیازمند تایید ادمین
        });

        await newCampaign.save();
        res.status(201).json({ success: true, message: 'کمپین با موفقیت ایجاد شد و در انتظار تایید ادمین است.', campaignId: newCampaign._id });
    } catch (err) {
        res.status(500).json({ error: 'خطا در ایجاد کمپین.' });
    }
});

// مشاهده آمار کمپین‌های یک تبلیغ‌کننده خاص
app.get('/api/advertiser/campaigns/:advertiserId', async (req, res) => {
    try {
        const campaigns = await Campaign.find({ advertiserId: req.params.advertiserId });
        res.json({ success: true, campaigns });
    } catch (err) {
        res.status(500).json({ error: 'خطا در دریافت لیست کمپین‌ها.' });
    }
});


// ==========================================
// ۵. بخش هسته مرکزی AD SERVER (نمایش هوشمند بنر برای ناشران)
// ==========================================
app.get('/ad/serve', async (req, res) => {
    try {
        const clientDevice = req.headers['sec-ch-ua-mobile'] === '?1' ? 'mobile' : 'desktop';

        // فقط کمپین‌های active و دارای بودجه
        const activeCampaigns = await Campaign.find({ 
            status: 'active',
            $expr: { $lt: ['$spent', '$budget'] } 
        });

        if (!activeCampaigns || activeCampaigns.length === 0) {
            return res.status(404).json({ error: 'هیچ تبلیغ فعالی وجود ندارد.' });
        }

        const eligibleCampaigns = activeCampaigns.filter(camp => 
            camp.targetDevice === 'all' || camp.targetDevice === clientDevice
        );

        const targetPool = eligibleCampaigns.length > 0 ? eligibleCampaigns : activeCampaigns;

        // الگوریتم وزن‌دهی بر اساس قیمت پیشنهادی (Bid)
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

        // افزایش تعداد نمایش و کسر هزینه در صورت CPM
        selectedCampaign.impressions = (selectedCampaign.impressions || 0) + 1;
        if (selectedCampaign.pricingType === 'CPM') {
            selectedCampaign.spent = (selectedCampaign.spent || 0) + (selectedCampaign.bidAmount / 1000);
        }

        if (selectedCampaign.spent >= selectedCampaign.budget) {
            selectedCampaign.status = 'exhausted';
        }

        await selectedCampaign.save();

        res.json({
            success: true,
            campaignId: selectedCampaign._id,
            title: selectedCampaign.title,
            bannerUrl: selectedCampaign.bannerUrl,
            targetUrl: selectedCampaign.targetUrl
        });

    } catch (err) {
        res.status(500).json({ error: 'خطا در سرویس‌دهی تبلیغ.' });
    }
});


// ==========================================
// ۶. موتور ثبت کلیک همراه با سیستم ضد تقلب فوق‌پیشرفته
// ==========================================
app.post('/campaigns/:id/click', standardRateLimiter, async (req, res) => {
    try {
        const campaignId = req.params.id;
        const clientIp = req.ip || req.headers['x-forwarded-for'] || 'unknown';
        const { fingerprint, userAgent, canvasHash } = req.body;

        const campaign = await Campaign.findById(campaignId);
        if (!campaign) {
            return res.status(404).json({ error: 'کمپین یافت نشد.' });
        }

        if (campaign.status !== 'active') {
            return res.status(400).json({ error: 'کمپین فعال نیست.' });
        }

        // بررسی ربات‌ها
        if (!userAgent || /bot|crawl|spider|slurp|headless|selenium|puppeteer/i.test(userAgent)) {
            await Campaign.findByIdAndUpdate(campaignId, {
                $inc: { invalidClicks: 1 },
                $push: { fraudLogs: { ip: clientIp, reason: 'Automated Bot / Headless Browser' } }
            });
            return res.status(403).json({ error: 'درخواست غیرمجاز.' });
        }

        // بررسی سرعت کلیک
        const now = Date.now();
        if (clickVelocityTracker.has(clientIp)) {
            const lastClickTime = clickVelocityTracker.get(clientIp);
            if (now - lastClickTime < 2000) {
                await Campaign.findByIdAndUpdate(campaignId, {
                    $inc: { invalidClicks: 1 },
                    $push: { fraudLogs: { ip: clientIp, reason: 'Unnatural click speed' } }
                });
                return res.status(429).json({ error: 'کلیک‌های متوالی سریع مجاز نیست.' });
            }
        }
        clickVelocityTracker.set(clientIp, now);

        // بررسی اثر انگشت مرورگر
        if (fingerprint || canvasHash) {
            const uniqueKey = `${campaignId}_${fingerprint || canvasHash}`;
            if (browserFingerprintTracker.has(uniqueKey)) {
                const lastFingerprintTime = browserFingerprintTracker.get(uniqueKey);
                if (now - lastFingerprintTime < 15 * 60 * 1000) {
                    await Campaign.findByIdAndUpdate(campaignId, {
                        $inc: { invalidClicks: 1 },
                        $push: { fraudLogs: { ip: clientIp, reason: 'Duplicate click from same fingerprint' } }
                    });
                    return res.status(400).json({ error: 'شما قبلاً روی این کمپین کلیک کرده‌اید.' });
                }
            }
            browserFingerprintTracker.set(uniqueKey, now);
        }

        // ثبت کلیک معتبر و کسر هزینه در صورت CPC
        campaign.clicks = (campaign.clicks || 0) + 1;
        if (campaign.pricingType === 'CPC') {
            campaign.spent = (campaign.spent || 0) + (campaign.bidAmount || 1);
        }

        if (campaign.spent >= campaign.budget) {
            campaign.status = 'exhausted';
        }

        await campaign.save();

        res.json({ 
            success: true, 
            message: 'کلیک معتبر تایید شد.', 
            targetUrl: campaign.targetUrl 
        });

    } catch (err) {
        res.status(500).json({ error: 'خطای سرور.' });
    }
});


// ==========================================
// ۷. بخش پنل ادمین (Admin Panel API)
// ==========================================
// مشاهده تمام کمپین‌های در انتظار تایید
app.get('/api/admin/campaigns/pending', async (req, res) => {
    try {
        const pendingCampaigns = await Campaign.find({ status: 'pending' });
        res.json({ success: true, pendingCampaigns });
    } catch (err) {
        res.status(500).json({ error: 'خطا در دریافت کمپین‌ها.' });
    }
});

// تایید یا رد کمپین توسط ادمین
app.post('/api/admin/campaigns/:id/status', async (req, res) => {
    try {
        const { status } = req.body; // 'active' یا 'rejected'
        const campaign = await Campaign.findByIdAndUpdate(req.params.id, { status }, { new: true });
        res.json({ success: true, message: `وضعیت کمپین به ${status} تغییر یافت.`, campaign });
    } catch (err) {
        res.status(500).json({ error: 'خطا در به‌روزرسانی وضعیت کمپین.' });
    }
});
// مسیر اصلی دریافت اطلاعات از فرانت‌اند و ارسال به جمینی
app.post('/api/generate-campaign', async (req, res) => {
  try {
    const { title, tone, style } = req.body;

    if (!title) {
      return res.status(400).json({ error: 'لطفاً عنوان یا موضوع کمپین را وارد کنید.' });
    }

    // انتخاب سریع‌ترین مدل متنی جمینی
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

    // ساخت یک پرامپت هوشمند بر اساس فیلدهای انتخابی کاربر
    const prompt = `تو یک متخصص تبلیغات آنلاین و کپی‌رایتر حرفه‌ای هستی. 
    یک متن تبلیغاتی جذاب، ترغیب‌کننده و کوتاه برای کمپینی با موضوع "${title}" بنویس.
    لحن متن باید "${tone}" باشد و برای سبک گرافیکی "${style}" مناسب باشد.
    پاسخ را به صورت مستقیم و بدون توضیحات اضافه بفرست.`;

    const result = await model.generateContent(prompt);
    const response = await result.response;
    const generatedText = response.text();

    res.json({ success: true, text: generatedText });

  } catch (error) {
    console.error('Gemini API Error:', error);
    res.status(500).json({ error: 'خطا در ارتباط با هوش مصنوعی جمینی رخ داده است.' });
  }
});

// راه‌اندازی سرور روی پورت ۳۰۰۰
const PORT = 3000;
app.listen(PORT, () => {
  console.log(`Full Ad Network Platform Server is running on port ${PORT}`);
});
