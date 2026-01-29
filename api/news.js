// api/news.js - 帶快取和成本控制的新聞抓取 API

// 使用記憶體快取（Vercel serverless 環境下的簡單快取）
let newsCache = null;
let cacheTimestamp = null;
const CACHE_DURATION = 30 * 60 * 1000; // 30 分鐘快取
const MAX_DAILY_REQUESTS = 50; // 每日最大 API 請求次數
let dailyRequestCount = 0;
let lastResetDate = new Date().toDateString();

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    // 每日計數器重置
    const currentDate = new Date().toDateString();
    if (currentDate !== lastResetDate) {
      dailyRequestCount = 0;
      lastResetDate = currentDate;
    }

    // 檢查快取是否有效
    const now = Date.now();
    if (newsCache && cacheTimestamp && (now - cacheTimestamp < CACHE_DURATION)) {
      console.log('從快取返回新聞');
      return res.status(200).json({
        success: true,
        news: newsCache,
        timestamp: new Date(cacheTimestamp).toISOString(),
        fromCache: true
      });
    }

    // 檢查每日請求限制
    if (dailyRequestCount >= MAX_DAILY_REQUESTS) {
      console.log('達到每日請求上限');
      return res.status(200).json({
        success: true,
        news: newsCache || getDefaultNews(),
        timestamp: new Date().toISOString(),
        fromCache: true,
        message: '已達每日更新上限，顯示快取新聞'
      });
    }

    // 獲取環境變量
    const NEWS_API_KEY = process.env.NEWS_API_KEY;
    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
    const API_KEY = OPENAI_API_KEY || ANTHROPIC_API_KEY;
    
    // 處理 BASE_URL，確保結尾沒有多餘的斜槓
    let BASE_URL = process.env.API_BASE_URL || 'https://api.openai.com/v1';
    if (BASE_URL.endsWith('/')) {
      BASE_URL = BASE_URL.slice(0, -1);
    }

    if (!NEWS_API_KEY) {
      throw new Error('未設定 NEWS_API_KEY 變量');
    }

    // 1. 從 NewsAPI 抓取新聞
    const newsResponse = await fetch(
      `https://newsapi.org/v2/top-headlines?category=business&language=en&pageSize=3&apiKey=${NEWS_API_KEY}`
    );
    
    if (!newsResponse.ok) {
      const errorText = await newsResponse.text();
      throw new Error(`NewsAPI 請求失敗: ${newsResponse.status} ${errorText}`);
    }

    const newsData = await newsResponse.json();
    const articles = newsData.articles || [];

    if (articles.length === 0) {
      throw new Error('NewsAPI 返回了空的新聞列表');
    }

    // 2. 檢查新聞是否與快取相同（避免重複翻譯）
    if (newsCache && articlesAreSame(articles, newsCache)) {
      console.log('新聞內容未變化，返回快取');
      cacheTimestamp = now;
      return res.status(200).json({
        success: true,
        news: newsCache,
        timestamp: new Date().toISOString(),
        fromCache: true
      });
    }

    // 3. 使用中轉 API 進行 AI 處理
    let processedNews;
    
    if (API_KEY) {
      const batchPrompt = articles.slice(0, 3).map((article, i) => 
        `新聞 ${i + 1}:
標題: ${article.title}
內容: ${article.description || article.content?.substring(0, 200) || ''}
來源: ${article.source.name}`
      ).join('\n\n---\n\n');

      try {
        dailyRequestCount++;
        
        // 構建請求 URL
        const apiUrl = `${BASE_URL}/chat/completions`;
        console.log(`正在請求 AI API: ${apiUrl}`);

        const aiResponse = await fetch(apiUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${API_KEY}`
          },
          body: JSON.stringify({
            model: process.env.AI_MODEL || 'gpt-4o-mini',
            messages: [
              {
                role: 'system',
                content: '你是一個專業的財經翻譯和分析助手。請將新聞翻譯成繁體中文，並提供投資解讀。'
              },
              {
                role: 'user',
                content: `請將以下 ${articles.slice(0, 3).length} 則英文財經新聞翻譯成繁體中文，並為每則新聞提供 AI 投資解讀。請以 JSON 陣列格式回應，不要包含 markdown 標記：

${batchPrompt}

回應格式（JSON 陣列）：
[
  {
    "title": "繁體中文標題",
    "summary": "繁體中文摘要（2-3句話）",
    "aiInsight": "AI 解讀（包含 emoji 開頭，分析市場影響，50-80字）",
    "category": "分類（貨幣政策/經濟數據/企業動態/地緣政治等）"
  }
]`
              }
            ],
            temperature: 0.7
          })
        });

        if (!aiResponse.ok) {
          const errorDetail = await aiResponse.text();
          console.error('AI API 錯誤詳情:', errorDetail);
          throw new Error(`AI API 響應錯誤 (${aiResponse.status})`);
        }

        const aiData = await aiResponse.json();
        
        if (!aiData.choices || !aiData.choices[0] || !aiData.choices[0].message) {
          throw new Error('AI API 返回格式不正確');
        }

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
        console.error('AI 處理失敗:', error);
        // 在摘要中顯示具體錯誤，方便調試
        processedNews = createFallbackNews(articles, `AI 處理出錯: ${error.message}`);
      }
    } else {
      // 沒有 API Key
      processedNews = createFallbackNews(articles, '未檢測到 API_KEY (OPENAI_API_KEY 或 ANTHROPIC_API_KEY)');
    }

    // 4. 更新快取
    newsCache = processedNews;
    cacheTimestamp = now;

    res.status(200).json({
      success: true,
      news: processedNews,
      timestamp: new Date().toISOString(),
      fromCache: false,
      dailyRequestsRemaining: MAX_DAILY_REQUESTS - dailyRequestCount
    });

  } catch (error) {
    console.error('API 總體錯誤:', error);
    res.status(200).json({
      success: false,
      error: error.message,
      news: newsCache || getDefaultNews(),
      timestamp: new Date().toISOString(),
      fromCache: true
    });
  }
}

function articlesAreSame(newArticles, cachedNews) {
  if (!cachedNews || newArticles.length !== cachedNews.length) return false;
  return newArticles.every((article, i) => 
    cachedNews[i] && article.title === cachedNews[i].originalTitle
  );
}

function createFallbackNews(articles, errorMessage = '') {
  return articles.slice(0, 3).map((article, index) => ({
    id: index + 1,
    title: article.title,
    source: article.source.name,
    time: getRelativeTime(article.publishedAt),
    summary: article.description || '請點擊閱讀原文查看詳情',
    aiInsight: `💡 ${errorMessage || '提示：請檢查 API Key 和 Base URL 設定'}`,
    category: '財經新聞',
    url: article.url,
    image: article.urlToImage,
    originalTitle: article.title
  }));
}

function getDefaultNews() {
  return [
    {
      id: 1,
      title: "歡迎使用 AI 財經工具站",
      source: "系統訊息",
      time: "現在",
      summary: "請檢查 Vercel 環境變量設定（NEWS_API_KEY, OPENAI_API_KEY, API_BASE_URL）。",
      aiInsight: "💡 設定完成後，您將獲得每日更新的財經新聞及專業 AI 投資分析。",
      category: "系統訊息",
      url: "https://github.com"
    }
  ];
}

function getRelativeTime(publishedAt) {
  const now = new Date();
  const published = new Date(publishedAt);
  const diffMs = now - published;
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffHours < 1) return '剛剛';
  if (diffHours < 24) return `${diffHours}小時前`;
  if (diffDays < 7) return `${diffDays}天前`;
  return published.toLocaleDateString('zh-TW');
}
