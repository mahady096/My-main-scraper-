const axios = require('axios');
const cheerio = require('cheerio');
const admin = require('firebase-admin');
const https = require('https');

// ✅ পরিবর্তন: সরাসরি JSON স্ট্রিং থেকে পার্স করা (Base64 ছাড়া)
try {
    const serviceAccountJSON = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
    if (!serviceAccountJSON) {
        throw new Error("FIREBASE_SERVICE_ACCOUNT_KEY environment variable is not set.");
    }
    const serviceAccount = JSON.parse(serviceAccountJSON);

    if (!admin.apps.length) {
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });
    }
    console.log("ফায়ারবেইজ অ্যাডমিন সফলভাবে ইনিশিয়ালাইজ হয়েছে।");
} catch (initError) {
    console.error("ফায়ারবেইজ ইনিশিয়ালাইজ করতে সমস্যা হয়েছে।", initError.message);
    process.exit(1);
}

const db = admin.firestore();
const httpsAgent = new https.Agent({ rejectUnauthorized: false });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function scrapeSingleCompany(companyCode, todayDate) {
    const detailUrl = `https://www.cse.com.bd/index.php?/company/companydetails/${companyCode}`;
    try {
        const { data } = await axios.get(detailUrl, {
            httpsAgent: httpsAgent,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });

        const $ = cheerio.load(data);
        
        let companyInfo = {
            code: companyCode,
            date: todayDate,
            ltp: "N/A",
            high: "N/A",
            low: "N/A",
            category: "N/A",
            eps: "N/A",
            pe_ratio: "N/A",
            dividend: "N/A",
            record_date: "N/A",
            updated_at: admin.firestore.FieldValue.serverTimestamp()
        };

        $('table tr').each((i, el) => {
            const cols = $(el).find('td');
            
            cols.each((index, td) => {
                const text = $(td).text().trim().toLowerCase();
                
                if (text.includes('last trade price (ltp)')) {
                    companyInfo.ltp = $(td).next('td').text().trim();
                } else if (text.includes("day's range")) {
                    const range = $(td).next('td').text().trim();
                    if (range && range.includes('-')) {
                        const parts = range.split('-');
                        companyInfo.low = parts[0].trim();
                        companyInfo.high = parts[1].trim();
                    }
                }
                else if (text.includes('market category')) {
                    companyInfo.category = $(td).next('td').text().trim();
                }
                else if (text.includes('hy eps') || (text === 'eps' && companyInfo.eps === "N/A")) {
                    companyInfo.eps = $(td).next('td').text().trim();
                }
                else if (text.includes('dividend(%)')) {
                    companyInfo.dividend = $(td).next('td').text().trim();
                } else if (text.includes('record date')) {
                    companyInfo.record_date = $(td).next('td').text().trim();
                }
            });
        });

        const ltpNum = parseFloat(companyInfo.ltp);
        const epsNum = parseFloat(companyInfo.eps);
        if (!isNaN(ltpNum) && !isNaN(epsNum) && epsNum !== 0) {
            companyInfo.pe_ratio = (ltpNum / epsNum).toFixed(2);
        }

        await db.collection('cse_detailed_data').doc(`${todayDate}_${companyCode}`).set(companyInfo, { merge: true });
        console.log(`✅ সফল: ${companyCode} -> LTP: ${companyInfo.ltp}, Cat: ${companyInfo.category}`);

    } catch (err) {
        console.error(`❌ ভুল হয়েছে ${companyCode} স্ক্র্যাপ করতে:`, err.message);
    }
}

async function startScraper() {
    console.log("📡 CSE ওয়েবসাইট থেকে কোম্পানির তালিকা আনা হচ্ছে...");
    const listUrl = "https://www.cse.com.bd/market/current_price"; 
    const todayDate = new Date().toISOString().split('T')[0];

    try {
        const { data } = await axios.get(listUrl, {
            httpsAgent: httpsAgent,
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
        });

        const $ = cheerio.load(data);
        let companies = [];

        $('table tr').each((index, element) => {
            if (index === 0) return;
            const cols = $(element).find('td');
            if (cols.length >= 2) {
                const companyCode = $(cols[1]).text().trim().replace(/[/\\.#$/[\]]/g, "-");
                if (companyCode && companyCode !== "" && !companies.includes(companyCode)) {
                    companies.push(companyCode);
                }
            }
        });

        console.log(`📊 মোট ${companies.length}টি কোম্পানি পাওয়া গেছে। স্ক্র্যাপিং শুরু হচ্ছে...`);

        const chunkSize = 10; 
        for (let i = 0; i < companies.length; i += chunkSize) {
            const chunk = companies.slice(i, i + chunkSize);
            console.log(`⏳ [${i + 1}-${Math.min(i + chunkSize, companies.length)} / ${companies.length}] প্রসেস হচ্ছে...`);
            
            await Promise.all(chunk.map(code => scrapeSingleCompany(code, todayDate)));
            await delay(500); 
        }

        console.log("🎉 সব তথ্য সফলভাবে ফায়ারবেইজে সেভ হয়েছে!");

    } catch (error) {
        console.error("❌ প্রধান তালিকা স্ক্র্যাপ করতে সমস্যা হয়েছে:", error.message);
    }
}

startScraper();
