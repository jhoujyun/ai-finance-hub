// api/calendar.js - 經濟日曆 API（動態生成未來7天的重要事件 - v6 穩定版）

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    const OPENAI_API_KEY = process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY;
    let BASE_URL = process.env.API_BASE_URL || 'https://api.openai.com/v1';
    if (BASE_URL.endsWith('/')) BASE_URL = BASE_URL.slice(0, -1);
    if (!BASE_URL.includes('/v1')) BASE_URL += '/v1';

    const MODEL = process.env.AI_MODEL || 'gpt-4o-mini';
    
    // 獲取未來7天的日期
    const today = new Date();
    const dateRange = [];
    for (let i = 0; i < 7; i++) {
      const date = new Date(today);
      date.setDate(today.getDate() + i);
      dateRange.push(date.toISOString().split('T')[0]);
    }

    // 使用 AI 生成本週經濟事件
    if (OPENAI_API_KEY) {
      try {
        const apiUrl = `${BASE_URL}/chat/completions`;
        
        const aiResponse = await fetch(apiUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${OPENAI_API_KEY}`,
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
          },
          body: JSON.stringify({
            model: MODEL,
            messages: [
              {
                role: 'system',
                content: '你是一個專業的財經分析助手。請根據日期生成未來7天內可能發生的重要全球經濟事件。'
              },
              {
                role: 'user',
                content: `請根據當前日期 ${today.toISOString().split('T')[0]} 生成未來7天內可能發生的重要全球經濟事件。

請以 JSON 陣列格式回應（不要包含 markdown 標記），每個事件包含：
- date: 日期（格式：YYYY-MM-DD，必須在未來7天內）
- event: 事件名稱（繁體中文）
- importance: "high" 或 "medium"
- previous: 前值（如適用）
- forecast: 預測值（如適用）
- aiAnalysis: AI 影響分析（50-100字，分析對市場的影響）

參考事件類型：美國/歐洲/中國重要經濟數據、央行利率決議、FOMC 會議紀要、重要企業財報、地緣政治事件。

請生成 4-6 個最重要的事件。

回應格式：
[
  {
    "date": "YYYY-MM-DD",
    "event": "事件名稱",
    "importance": "high",
    "previous": "前值",
    "forecast": "預測值",
    "aiAnalysis": "分析內容"
  }
]`
              }
            ],
            temperature: 0.7
          })
        });

        if (!aiResponse.ok) {
          const errorDetail = await aiResponse.text();
          if (errorDetail.includes('<!DOCTYPE html>')) {
            throw new Error('被 Cloudflare 攔截。請檢查中轉站地址。');
          }
          throw new Error(`AI API 錯誤 (${aiResponse.status})`);
        }

        const aiData = await aiResponse.json();
        const responseText = aiData.choices[0].message.content;
        const cleanedText = responseText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        const calendarEvents = JSON.parse(cleanedText);

        return res.status(200).json({
          success: true,
          events: calendarEvents,
          timestamp: new Date().toISOString()
        });

      } catch (error) {
        console.error('AI 生成經濟日曆失敗:', error);
        return res.status(200).json({
          success: true,
          events: getStaticCalendar(),
          timestamp: new Date().toISOString(),
          isStatic: true,
          error: error.message
        });
      }
    } else {
      return res.status(200).json({
        success: true,
        events: getStaticCalendar(),
        timestamp: new Date().toISOString(),
        isStatic: true
      });
    }

  } catch (error) {
    console.error('經濟日曆 API 錯誤:', error);
    res.status(200).json({
      success: false,
      error: error.message,
      events: getStaticCalendar(),
      timestamp: new Date().toISOString()
    });
  }
}

// 靜態經濟日曆（備用）
function getStaticCalendar() {
  const today = new Date();
  const events = [];
  
  const staticEvents = [
    {
      daysOffset: 0,
      event: "美國初領失業金人數",
      importance: "high",
      previous: "21.2萬",
      forecast: "22萬",
      aiAnalysis: "若數據高於預期，可能強化聯準會鴿派立場，利好股市；低於預期則相反。"
    },
    {
      daysOffset: 1,
      event: "歐元區 CPI 年率終值",
      importance: "medium",
      previous: "2.4%",
      forecast: "2.4%",
      aiAnalysis: "通膨數據符合預期將支持歐洲央行繼續降息，利好歐股和歐元。"
    },
    {
      daysOffset: 3,
      event: "美國 GDP 季率初值",
      importance: "high",
      previous: "3.1%",
      forecast: "2.8%",
      aiAnalysis: "GDP 放緩符合軟著陸預期，但若大幅低於 2.5% 可能引發衰退擔憂。"
    },
    {
      daysOffset: 4,
      event: "中國官方製造業 PMI",
      importance: "medium",
      previous: "50.1",
      forecast: "50.3",
      aiAnalysis: "PMI 持續擴張顯示中國經濟復甦動能，利好 A 股和港股。"
    },
    {
      daysOffset: 5,
      event: "美國非農就業人數",
      importance: "high",
      previous: "22.7萬",
      forecast: "18萬",
      aiAnalysis: "就業數據放緩支持聯準會降息預期，但需關注薪資增長是否同步放緩。"
    }
  ];

  staticEvents.forEach(event => {
    const eventDate = new Date(today);
    eventDate.setDate(today.getDate() + event.daysOffset);
    
    events.push({
      date: eventDate.toISOString().split('T')[0],
      event: event.event,
      importance: event.importance,
      previous: event.previous,
      forecast: event.forecast,
      aiAnalysis: event.aiAnalysis
    });
  });

  return events;
}
