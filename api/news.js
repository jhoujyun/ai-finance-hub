// api/news.js - 帶快取和成本控制的新聞抓取 API (v4 - Anthropic 原生格式優化版)

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
    // 優先使用 ANTHROPIC_API_KEY，兼容 cr-*** 格式
    const API_KEY = process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY;
    
    // 注意：Anthropic 原生中轉地址通常不帶 /v1，或者有特定的路徑
    let BASE_URL = process.env.API_BASE_URL || 'https://api.anthropic.com';
    const MODEL = process.env.AI_MODEL || 'claude-3-5-sonnet-20240620';

    if (BASE_URL.endsWith('/')) BASE_URL = BASE_URL.slice(0, -1);
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

    // 2. AI 處理 (使用 Anthropic 原生格式)
    let processedNews;
    if (API_KEY) {
      const batchPrompt = articles.slice(0, 3).map((article, i) => 
        `新聞 ${i + 1}:\n標題: ${article.title}\n內容: ${article.description || article.content?.substring(0, 200) || ''}\n來源: ${article.source.name}`
      ).join('\n\n---\n\n');

      try {
        dailyRequestCount++;
        
        // Anthropic 原生 API 路徑是 /v1/messages
        const apiUrl = BASE_URL.includes('/v1') ? `${BASE_URL}/messages` : `${BASE_URL}/v1/messages`;
        
        const aiResponse = await fetch(apiUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': API_KEY,
            'anthropic-version': '2023-06-01'
          },
          body: JSON.stringify({
            model: MODEL,
            max_tokens: 2000,
            messages: [
              { 
                role: 'user', 
                content: `請將以下新聞翻譯成繁體中文，並提供 AI 投資解讀。請以 JSON 陣列格式回應，不要包含任何 markdown 標記或多餘文字：\n\n${batchPrompt}\n\n回應格式（純 JSON 陣列）：\n[{"title":"繁體中文標題","summary":"摘要","aiInsight":"解讀","category":"分類"}]` 
              }
            ],
            temperature: 0
          })
        });

        if (!aiResponse.ok) {
          const errorDetail = await aiResponse.text();
          throw new Error(`AI API 錯誤 (${aiResponse.status}): ${errorDetail.substring(0, 100)}`);
        }

        const aiData = await aiResponse.json();
        const responseText = aiData.content[0].text;
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
        console.error('AI 處理失敗:', error);
        processedNews = createFallbackNews(articles, `AI 格式錯誤: ${error.message}`);
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
  return [{ id: 1, title: "系統訊息", source: "系統", time: "現在", summary: "請檢查環境變量設定。", aiInsight: "💡 提示：請確保 API_BASE_URL 與 cr-*** 密鑰匹配。", category: "系統", url: "#" }];
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
