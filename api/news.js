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

    const NEWS_API_KEY = process.env.NEWS_API_KEY;
    const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

    if (!NEWS_API_KEY) {
      throw new Error('未設定 NEWS_API_KEY');
    }

    // 1. 從 NewsAPI 抓取新聞
    const newsResponse = await fetch(
      `https://newsapi.org/v2/top-headlines?category=business&language=en&pageSize=3&apiKey=${NEWS_API_KEY}`
    );
    
    if (!newsResponse.ok) {
      throw new Error('NewsAPI 請求失敗');
    }

    const newsData = await newsResponse.json();
    const articles = newsData.articles || [];

    if (articles.length === 0) {
      throw new Error('沒有獲取到新聞');
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

    // 3. 只在有 ANTHROPIC_API_KEY 時才使用 AI 翻譯
    let processedNews;
    
    if (ANTHROPIC_API_KEY) {
      // 批次處理：一次性發送所有新聞給 Claude（省 tokens）
      const batchPrompt = articles.slice(0, 3).map((article, i) => 
        `新聞 ${i + 1}:
標題: ${article.title}
內容: ${article.description || article.content?.substring(0, 200) || ''}
來源: ${article.source.name}`
      ).join('\n\n---\n\n');

      try {
        dailyRequestCount++; // 增加請求計數
        
        const claudeResponse = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01'
          },
          body: JSON.stringify({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 2000,
            messages: [{
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
            }]
          })
        });

        if (!claudeResponse.ok) {
          console.error('Claude API 錯誤:', await claudeResponse.text());
          throw new Error('Claude API 請求失敗');
        }

        const claudeData = await claudeResponse.json();
        const responseText = claudeData.content[0].text;
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
          originalTitle: articles[index].title // 用於比對快取
        }));

      } catch (error) {
        console.error('AI 處理失敗，使用備用方案:', error);
        processedNews = createFallbackNews(articles);
      }
    } else {
      // 沒有 API Key，使用備用方案
      processedNews = createFallbackNews(articles);
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
    console.error('API 錯誤:', error);
    
    // 錯誤時返回快取或預設新聞
    res.status(200).json({
      success: false,
      error: error.message,
      news: newsCache || getDefaultNews(),
      timestamp: new Date().toISOString(),
      fromCache: true
    });
  }
}

// 檢查新聞是否相同（比對標題）
function articlesAreSame(newArticles, cachedNews) {
  if (!cachedNews || newArticles.length !== cachedNews.length) return false;
  
  return newArticles.every((article, i) => 
    cachedNews[i] && article.title === cachedNews[i].originalTitle
  );
}

// 備用方案：不使用 AI 的簡單翻譯
function createFallbackNews(articles) {
  return articles.slice(0, 3).map((article, index) => ({
    id: index + 1,
    title: article.title, // 保留英文標題
    source: article.source.name,
    time: getRelativeTime(article.publishedAt),
    summary: article.description || '請點擊閱讀原文查看詳情',
    aiInsight: '💡 提示：請設定 Claude API Key 以啟用 AI 繁中翻譯和深度解讀功能',
    category: '財經新聞',
    url: article.url,
    image: article.urlToImage,
    originalTitle: article.title
  }));
}

// 預設新聞（當所有來源都失敗時）
function getDefaultNews() {
  return [
    {
      id: 1,
      title: "歡迎使用 AI 財經工具站",
      source: "系統訊息",
      time: "現在",
      summary: "請設定 NewsAPI 和 Claude API 金鑰以獲取即時全球財經新聞和 AI 解讀。",
      aiInsight: "💡 設定完成後，您將獲得每日更新的財經新聞及專業 AI 投資分析。",
      category: "系統訊息",
      url: "https://console.anthropic.com"
    }
  ];
}

// 計算相對時間
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