// api/news.js - 帶快取和成本控制的新聞抓取 API (v5 - 深度偽裝 & 繞過攔截版)

let newsCache = null;
let cacheTimestamp = null;
const CACHE_DURATION = 30 * 60 * 1000; 
const MAX_DAILY_REQUESTS = 50; 
let dailyRequestCount = 0;
let lastResetDate = new Date().toDateString();

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const currentDate = new Date().toDateString();
    if (currentDate !== lastResetDate) {
      dailyRequestCount = 0;
      lastResetDate = currentDate;
    }

    const now = Date.now();
    if (newsCache && cacheTimestamp && (now - cacheTimestamp < CACHE_DURATION)) {
      return res.status(200).json({ success: true, news: newsCache, timestamp: new Date(cacheTimestamp).toISOString(), fromCache: true });
    }

    if (dailyRequestCount >= MAX_DAILY_REQUESTS) {
      return res.status(200).json({ success: true, news: newsCache || getDefaultNews(), timestamp: new Date().toISOString(), fromCache: true, message: '已達每日更新上限' });
    }

    const NEWS_API_KEY = process.env.NEWS_API_KEY;
    // 兼容 cr-*** 密鑰，無論放在哪個變量都能讀取
    const API_KEY = process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY;
    
    // 處理 BASE_URL
    let BASE_URL = process.env.API_BASE_URL || 'https://api.openai.com/v1';
    if (BASE_URL.endsWith('/')) BASE_URL = BASE_URL.slice(0, -1);
    
    // 自動補全 /v1 路徑（如果用戶沒填的話）
    if (!BASE_URL.includes('/v1') && !BASE_URL.includes('anthropic.com')) {
      BASE_URL += '/v1';
    }

    const MODEL = process.env.AI_MODEL || 'gpt-4o-mini';

    if (!NEWS_API_KEY) throw new Error('未設定 NEWS_API_KEY');

    // 1. 抓取新聞
    const newsResponse = await fetch(`https://newsapi.org/v2/top-headlines?category=business&language=en&pageSize=3&apiKey=${NEWS_API_KEY}`);
    if (!newsResponse.ok) throw new Error(`NewsAPI 錯誤: ${newsResponse.status}`);
    const newsData = await newsResponse.json();
    const articles = newsData.articles || [];
    if (articles.length === 0) throw new Error('未獲取到新聞內容');

    if (newsCache && articlesAreSame(articles, newsCache)) {
      cacheTimestamp = now;
      return res.status(200).json({ success: true, news: newsCache, timestamp: new Date().toISOString(), fromCache: true });
    }

    // 2. AI 處理 (採用 OpenAI 兼容路徑，這對中轉站最友好)
    let processedNews;
    if (API_KEY) {
      const batchPrompt = articles.slice(0, 3).map((article, i) => 
        `新聞 ${i + 1}:\n標題: ${article.title}\n內容: ${article.description || article.content?.substring(0, 200) || ''}\n來源: ${article.source.name}`
      ).join('\n\n---\n\n');

      try {
        dailyRequestCount++;
        
        // 構建 OpenAI 兼容路徑
        const apiUrl = `${BASE_URL}/chat/completions`;

        const aiResponse = await fetch(apiUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${API_KEY}`,
            // 深度偽裝 Header，繞過 Cloudflare 基礎攔截
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'application/json',
            'Origin': 'https://vercel.com',
            'Referer': 'https://vercel.com/'
          },
          body: JSON.stringify({
            model: MODEL,
            messages: [
              { role: 'system', content: '你是一個專業的財經翻譯和分析助手。請將新聞翻譯成繁體中文，並提供投資解讀。' },
              { role: 'user', content: `請將以下新聞翻譯成繁體中文，並提供 AI 投資解讀。請以 JSON 陣列格式回應：\n\n${batchPrompt}\n\n回應格式：[{"title":"...","summary":"...","aiInsight":"...","category":"..."}]` }
            ],
            temperature: 0.7
          })
        });

        if (!aiResponse.ok) {
          const errorDetail = await aiResponse.text();
          // 如果返回 HTML，說明被 Cloudflare 攔截了
          if (errorDetail.includes('<!DOCTYPE html>')) {
            throw new Error(`被 Cloudflare 攔截 (403)。建議：請檢查 API_BASE_URL 是否正確，或更換中轉站地址。`);
          }
          throw new Error(`AI API 錯誤 (${aiResponse.status}): ${errorDetail.substring(0, 50)}`);
        }

        const aiData = await aiResponse.json();
        const responseText = aiData.choices[0].message.content;
        const cleanedText = responseText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        const parsedArray = JSON.parse(cleanedText);

        processedNews = parsedArray.map((parsed, index) => ({
          id: index + 1,
          title: parsed.title,
          source: articles[index].source.name,
          time: getRelativeTime(articles[index].publishedAt),
          summary: parsed.summary,
          aiInsight: parsed.aiInsight,
          category: parsed.category,
          url: articles[index].url,
          image: articles[index].urlToImage,
          originalTitle: articles[index].title
        }));
      } catch (error) {
        processedNews = createFallbackNews(articles, error.message);
      }
    } else {
      processedNews = createFallbackNews(articles, '缺少 API_KEY');
    }

    newsCache = processedNews;
    cacheTimestamp = now;
    res.status(200).json({ success: true, news: processedNews, timestamp: new Date().toISOString(), fromCache: false });

  } catch (error) {
    res.status(200).json({ success: false, error: error.message, news: newsCache || getDefaultNews(), timestamp: new Date().toISOString(), fromCache: true });
  }
}

function articlesAreSame(newArticles, cachedNews) {
  if (!cachedNews || newArticles.length !== cachedNews.length) return false;
  return newArticles.every((article, i) => cachedNews[i] && article.title === cachedNews[i].originalTitle);
}

function createFallbackNews(articles, errorMessage = '') {
  return articles.slice(0, 3).map((article, index) => ({
    id: index + 1,
    title: article.title,
    source: article.source.name,
    time: getRelativeTime(article.publishedAt),
    summary: article.description || '請點擊閱讀原文查看詳情',
    aiInsight: `💡 狀態：${errorMessage}`,
    category: '系統提示',
    url: article.url,
    image: article.urlToImage,
    originalTitle: article.title
  }));
}

function getDefaultNews() {
  return [{ id: 1, title: "系統訊息", source: "系統", time: "現在", summary: "請檢查環境變量設定。", aiInsight: "💡 提示：若出現 403，請確認中轉站地址是否支持 Vercel 訪問。", category: "系統", url: "#" }];
}

function getRelativeTime(publishedAt) {
  const now = new Date();
  const published = new Date(publishedAt);
  const diffMs = now - published;
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  if (diffHours < 1) return '剛剛';
  if (diffHours < 24) return `${diffHours}小時前`;
  return published.toLocaleDateString('zh-TW');
}
