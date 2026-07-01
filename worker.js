// ============================================
// JARVIS - Cloudflare Worker Backend v2.0
// Kadir Tercan - Kişisel AI Asistan
// Groq + Tavily Web Search + Saat/Tarih
// ============================================

const SYSTEM_PROMPT_BASE = `Sen Jarvis'sin — Kadir'in kisisel AI asistani. Turkce konusursun, samimi ama profesyonelsin.

KURALLAR:
- Kisa ve oz cevaplar ver, gereksiz uzatma
- Teknik konularda (TwinCAT 3, Beckhoff, Siemens TIA Portal, ABB OmniCore, FANUC) detayli yardim edebilirsin
- Kullanici not almak, gorev eklemek veya hatirlatma kurmak istediginde uygun fonksiyonu cagir
- Gunluk muhabbette samimi ol, emoji kullanabilirsin
- Fitness, araba (1995 Corolla XLi), Ingilizce ogrenme konularinda da yardimci ol
- Sana verilen GUNCEL BILGILER bolumundeki tarih/saat bilgisini kullan
- Eger web arama sonuclari verilmisse, onlari kullanarak guncel ve dogru cevap ver

FONKSIYONLAR:
Kullanici asagidaki islemleri istediginde, cevabinin icine JSON formatinda komut yerlestir:
- Not almak isterse: {"action":"addNote","content":"not icerigi"}
- Gorev eklemek isterse: {"action":"addTask","content":"gorev icerigi"}
- Hatirlatma kurmak isterse: {"action":"addReminder","content":"hatirlatma icerigi","due_at":"ISO tarih formatinda"}
- Notlari gormek isterse: {"action":"getNotes"}
- Gorevleri gormek isterse: {"action":"getTasks"}
- Gorevi tamamlamak isterse: {"action":"completeTask","content":"gorev aciklamasi"}
- Silmek isterse: {"action":"deleteNote","content":"silinecek not aciklamasi"}

ONEMLI KURALLAR:
1. Her mesajda EN FAZLA BIR fonksiyon cagir
2. JSON'i cevap metninin SONUNA, --- ayracindan sonra koy
3. due_at alanini ISO formatinda yaz (ornek: 2026-07-02T10:30:00+03:00)
4. Hatirlatma icin kullanicinin verdigi saati kullan, tarih bilgisini GUNCEL BILGILER'den al

Ornek:
Tabii, notu kaydettim!
---
{"action":"addNote","content":"AX5125 PDO mapping kontrol edilecek"}`;

// ============================================
// SEARCH KEYWORDS - Tavily araması gerekip gerekmediğini belirle
// ============================================

function needsWebSearch(message) {
  const searchTriggers = [
    'hava', 'weather', 'sicaklik', 'derece',
    'haber', 'news', 'gundem', 'son dakika',
    'fiyat', 'kur', 'dolar', 'euro', 'altin', 'bitcoin',
    'mac', 'skor', 'lig', 'sampiyonluk',
    'kimdir', 'nedir', 'ne zaman', 'nasil yapilir',
    'tarif', 'recete',
    'film', 'dizi', 'imdb',
    'adres', 'nerede', 'telefon numarasi',
    'google', 'ara', 'bul', 'search',
    'son', 'yeni', 'guncel', 'bugun', 'bugunki',
    'deprem', 'trafik', 'yol durumu',
    'doviz', 'borsa', 'faiz'
  ];
  const lower = message.toLowerCase();
  return searchTriggers.some(function(trigger) {
    return lower.includes(trigger);
  });
}

// ============================================
// TAVILY WEB SEARCH
// ============================================

async function tavilySearch(env, query) {
  try {
    var res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: env.TAVILY_API_KEY,
        query: query,
        search_depth: 'basic',
        max_results: 3,
        include_answer: true
      })
    });

    if (!res.ok) {
      console.error('Tavily error:', await res.text());
      return null;
    }

    var data = await res.json();
    var result = '';

    if (data.answer) {
      result += 'Ozet: ' + data.answer + '\n\n';
    }

    if (data.results && data.results.length > 0) {
      result += 'Kaynaklar:\n';
      for (var i = 0; i < data.results.length && i < 3; i++) {
        var r = data.results[i];
        result += (i + 1) + '. ' + r.title + ': ' + r.content.substring(0, 200) + '\n';
      }
    }

    return result || null;
  } catch (e) {
    console.error('Tavily exception:', e);
    return null;
  }
}

// ============================================
// FREE WEATHER (wttr.in)
// ============================================

async function getWeather(city) {
  try {
    var res = await fetch('https://wttr.in/' + encodeURIComponent(city) + '?format=j1', {
      headers: { 'User-Agent': 'Jarvis-Bot' }
    });
    if (!res.ok) return null;
    var data = await res.json();
    var current = data.current_condition[0];
    return 'Sehir: ' + city + ', Sicaklik: ' + current.temp_C + 'C, Durum: ' + current.weatherDesc[0].value + ', Nem: ' + current.humidity + '%, Ruzgar: ' + current.windspeedKmph + ' km/h';
  } catch (e) {
    return null;
  }
}

function needsWeather(message) {
  var lower = message.toLowerCase();
  return (lower.includes('hava') && (lower.includes('durumu') || lower.includes('nasil') || lower.includes('sicak') || lower.includes('soguk') || lower.includes('yagmur'))) || lower.includes('weather') || lower.includes('sicaklik') || lower.includes('derece');
}

function extractCity(message) {
  var cities = ['eskisehir', 'istanbul', 'ankara', 'izmir', 'bursa', 'antalya', 'konya', 'adana', 'kocaeli', 'gaziantep', 'mersin', 'samsun', 'trabzon', 'erzurum', 'diyarbakir', 'kayseri'];
  var lower = message.toLowerCase().replace(/ş/g, 's').replace(/ı/g, 'i').replace(/ğ/g, 'g').replace(/ü/g, 'u').replace(/ö/g, 'o').replace(/ç/g, 'c');
  for (var i = 0; i < cities.length; i++) {
    if (lower.includes(cities[i])) return cities[i];
  }
  return 'eskisehir'; // default
}

// ============================================
// GET CURRENT TIME (Turkey)
// ============================================

function getCurrentTime() {
  var now = new Date();
  var turkeyOffset = 3 * 60; // UTC+3
  var utc = now.getTime() + (now.getTimezoneOffset() * 60000);
  var turkeyTime = new Date(utc + (turkeyOffset * 60000));

  var days = ['Pazar', 'Pazartesi', 'Sali', 'Carsamba', 'Persembe', 'Cuma', 'Cumartesi'];
  var months = ['Ocak', 'Subat', 'Mart', 'Nisan', 'Mayis', 'Haziran', 'Temmuz', 'Agustos', 'Eylul', 'Ekim', 'Kasim', 'Aralik'];

  var dayName = days[turkeyTime.getDay()];
  var day = turkeyTime.getDate();
  var month = months[turkeyTime.getMonth()];
  var year = turkeyTime.getFullYear();
  var hours = String(turkeyTime.getHours()).padStart(2, '0');
  var minutes = String(turkeyTime.getMinutes()).padStart(2, '0');

  return {
    formatted: dayName + ', ' + day + ' ' + month + ' ' + year + ' - Saat: ' + hours + ':' + minutes,
    iso: turkeyTime.toISOString(),
    date: year + '-' + String(turkeyTime.getMonth() + 1).padStart(2, '0') + '-' + String(day).padStart(2, '0'),
    time: hours + ':' + minutes
  };
}

// ============================================
// SUPABASE HELPERS
// ============================================

async function supabaseRequest(env, path, method, body) {
  var opts = {
    method: method || 'GET',
    headers: {
      'apikey': env.SUPABASE_KEY,
      'Authorization': 'Bearer ' + env.SUPABASE_KEY,
      'Content-Type': 'application/json'
    }
  };
  if (method === 'POST') opts.headers['Prefer'] = 'return=representation';
  if (body) opts.body = JSON.stringify(body);
  var res = await fetch(env.SUPABASE_URL + '/rest/v1/' + path, opts);
  if (!res.ok) { console.error('Supabase error:', await res.text()); return null; }
  var text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function getMemory(env) {
  var data = await supabaseRequest(env, 'memory?select=summary&limit=1');
  return data && data.length > 0 ? data[0].summary : '';
}

async function updateMemory(env, summary) {
  await supabaseRequest(env, 'memory', 'PATCH', { summary: summary, updated_at: new Date().toISOString() });
}

async function getRecentMessages(env, limit) {
  var data = await supabaseRequest(env, 'messages?select=role,content,created_at&order=created_at.desc&limit=' + (limit || 15));
  return data ? data.reverse() : [];
}

async function saveMessage(env, role, content, source) {
  await supabaseRequest(env, 'messages', 'POST', { role: role, content: content, source: source || 'web' });
}

async function getMessageCount(env) {
  var data = await supabaseRequest(env, 'messages?select=id&order=created_at.desc&limit=100');
  return data ? data.length : 0;
}

async function getNotes(env, type) {
  var path = 'notes?select=*&order=created_at.desc&is_done=eq.false';
  if (type) path += '&type=eq.' + type;
  return await supabaseRequest(env, path) || [];
}

async function addNote(env, type, content, due_at) {
  var body = { type: type, content: content };
  if (due_at) body.due_at = due_at;
  return await supabaseRequest(env, 'notes', 'POST', body);
}

async function completeTask(env, content) {
  var notes = await getNotes(env, 'task');
  var match = notes.find(function(n) { return n.content.toLowerCase().includes(content.toLowerCase()); });
  if (match) { await supabaseRequest(env, 'notes?id=eq.' + match.id, 'PATCH', { is_done: true }); return true; }
  return false;
}

async function deleteNote(env, content) {
  var notes = await getNotes(env);
  var match = notes.find(function(n) { return n.content.toLowerCase().includes(content.toLowerCase()); });
  if (match) { await supabaseRequest(env, 'notes?id=eq.' + match.id, 'DELETE'); return true; }
  return false;
}

async function getPendingReminders(env) {
  var now = new Date().toISOString();
  return await supabaseRequest(env, 'notes?select=*&type=eq.reminder&notified=eq.false&due_at=lte.' + now) || [];
}

async function markNotified(env, id) {
  await supabaseRequest(env, 'notes?id=eq.' + id, 'PATCH', { notified: true });
}

// ============================================
// GROQ API
// ============================================

async function askGroq(env, messages) {
  var res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + env.GROQ_API_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      messages: messages,
      max_tokens: 2048,
      temperature: 0.7
    })
  });

  if (!res.ok) {
    var err = await res.text();
    console.error('Groq error:', err);
    return 'Uzgunum, su an AI servisine ulasamiyorum. Biraz sonra tekrar dene.';
  }

  var data = await res.json();
  return data.choices[0].message.content;
}

// ============================================
// PROCESS AI ACTIONS
// ============================================

async function processActions(env, aiResponse) {
  var parts = aiResponse.split('---');
  if (parts.length < 2) return { cleanResponse: aiResponse, actionResults: [] };

  var cleanResponse = parts[0].trim();
  var actionPart = parts.slice(1).join('---').trim();
  var actionResults = [];

  // Try to extract JSON from actionPart (might have extra text)
  var jsonMatch = actionPart.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return { cleanResponse: aiResponse, actionResults: [] };

  try {
    var action = JSON.parse(jsonMatch[0]);

    if (action.action === 'addNote') {
      await addNote(env, 'note', action.content);
      actionResults.push('Not kaydedildi: ' + action.content);
    } else if (action.action === 'addTask') {
      await addNote(env, 'task', action.content);
      actionResults.push('Gorev eklendi: ' + action.content);
    } else if (action.action === 'addReminder') {
      await addNote(env, 'reminder', action.content, action.due_at);
      actionResults.push('Hatirlatma kuruldu: ' + action.content);
    } else if (action.action === 'getNotes') {
      var notes = await getNotes(env);
      if (notes.length === 0) {
        actionResults.push('Henuz hic notun yok.');
      } else {
        actionResults.push('Notlarin:\n' + notes.map(function(n, i) {
          return (i + 1) + '. [' + n.type + '] ' + n.content;
        }).join('\n'));
      }
    } else if (action.action === 'getTasks') {
      var tasks = await getNotes(env, 'task');
      if (tasks.length === 0) {
        actionResults.push('Aktif gorevin yok, harika!');
      } else {
        actionResults.push('Aktif gorevlerin:\n' + tasks.map(function(t, i) {
          return (i + 1) + '. ' + t.content;
        }).join('\n'));
      }
    } else if (action.action === 'completeTask') {
      var success = await completeTask(env, action.content);
      actionResults.push(success ? 'Gorev tamamlandi: ' + action.content : 'Eslesen gorev bulunamadi.');
    } else if (action.action === 'deleteNote') {
      var success2 = await deleteNote(env, action.content);
      actionResults.push(success2 ? 'Silindi: ' + action.content : 'Eslesen kayit bulunamadi.');
    }
  } catch (e) {
    console.error('Action parse error:', e);
    return { cleanResponse: aiResponse, actionResults: [] };
  }

  return { cleanResponse: cleanResponse, actionResults: actionResults };
}

// ============================================
// MEMORY REFRESH (every ~20 messages)
// ============================================

async function maybeRefreshMemory(env) {
  var count = await getMessageCount(env);
  if (count > 0 && count % 20 === 0) {
    var messages = await getRecentMessages(env, 30);
    var msgText = messages.map(function(m) { return m.role + ': ' + m.content; }).join('\n');

    var summary = await askGroq(env, [
      { role: 'system', content: 'Asagidaki konusma gecmisinden kullanici hakkinda onemli bilgileri Turkce olarak ozetle. Kisa ve madde madde yaz. Is, hobiler, projeler, tercihler gibi kalici bilgilere odaklan. Maksimum 500 kelime.' },
      { role: 'user', content: msgText }
    ]);

    var currentMemory = await getMemory(env);
    var merged = currentMemory + '\n\n[Guncelleme]: ' + summary;
    if (merged.length > 1500) merged = merged.slice(-1500);
    await updateMemory(env, merged);
  }
}

// ============================================
// MAIN CHAT HANDLER
// ============================================

async function handleChat(env, userMessage, source) {
  // 1. Get time info
  var timeInfo = getCurrentTime();

  // 2. Check if web search is needed
  var searchResults = null;
  var weatherInfo = null;

  if (needsWeather(userMessage)) {
    var city = extractCity(userMessage);
    weatherInfo = await getWeather(city);
  } else if (needsWebSearch(userMessage)) {
    searchResults = await tavilySearch(env, userMessage);
  }

  // 3. Get memory and recent messages
  var memory = await getMemory(env);
  var recentMessages = await getRecentMessages(env, 15);

  // 4. Build system prompt
  var systemPrompt = SYSTEM_PROMPT_BASE;

  // Add current time
  systemPrompt += '\n\nGUNCEL BILGILER:\nTarih ve Saat: ' + timeInfo.formatted;
  systemPrompt += '\nISO Tarih: ' + timeInfo.date;
  systemPrompt += '\nSaat: ' + timeInfo.time;
  systemPrompt += '\nTimezone: UTC+3 (Turkiye)';

  // Add weather if available
  if (weatherInfo) {
    systemPrompt += '\n\nHAVA DURUMU:\n' + weatherInfo;
  }

  // Add search results if available
  if (searchResults) {
    systemPrompt += '\n\nWEB ARAMA SONUCLARI:\n' + searchResults;
    systemPrompt += '\n\nBu arama sonuclarini kullanarak kullaniciya guncel ve dogru bilgi ver.';
  }

  // Add memory
  if (memory) {
    systemPrompt += '\n\nKADIR HAKKINDA BILDIKLERIN:\n' + memory;
  }

  // 5. Build messages array
  var groqMessages = [{ role: 'system', content: systemPrompt }];
  for (var i = 0; i < recentMessages.length; i++) {
    groqMessages.push({ role: recentMessages[i].role, content: recentMessages[i].content });
  }
  groqMessages.push({ role: 'user', content: userMessage });

  // 6. Ask Groq
  var aiResponse = await askGroq(env, groqMessages);

  // 7. Process actions
  var result = await processActions(env, aiResponse);
  var finalResponse = result.cleanResponse;
  if (result.actionResults.length > 0) {
    finalResponse = result.cleanResponse + '\n\n' + result.actionResults.join('\n');
  }

  // 8. Save messages
  await saveMessage(env, 'user', userMessage, source || 'web');
  await saveMessage(env, 'assistant', finalResponse, source || 'web');

  // 9. Maybe refresh memory
  await maybeRefreshMemory(env);

  return finalResponse;
}

// ============================================
// TELEGRAM HANDLER
// ============================================

async function sendTelegram(env, chatId, text) {
  await fetch('https://api.telegram.org/bot' + env.TELEGRAM_TOKEN + '/sendMessage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: text
    })
  });
}

async function handleTelegram(env, request) {
  var body = await request.json();

  if (!body.message || !body.message.text) {
    return new Response('ok');
  }

  var chatId = body.message.chat.id;
  var text = body.message.text;

  if (chatId.toString() !== env.TELEGRAM_CHAT_ID) {
    return new Response('ok');
  }

  if (text === '/start') {
    await sendTelegram(env, chatId, 'Merhaba Kadir! Ben Jarvis, kisisel asistanin.\n\nBana her seyi sorabilirsin! Hava durumu, guncel haberler, not alma, hatirlatma kurma...');
    return new Response('ok');
  }

  if (text === '/export') {
    var notes = await getNotes(env);
    if (notes.length === 0) {
      await sendTelegram(env, chatId, 'Henuz kayitli notun yok.');
    } else {
      await sendTelegram(env, chatId, 'Notlarin:\n' + notes.map(function(n, i) {
        return (i + 1) + '. [' + n.type + '] ' + n.content;
      }).join('\n'));
    }
    return new Response('ok');
  }

  var response = await handleChat(env, text, 'telegram');
  await sendTelegram(env, chatId, response);

  return new Response('ok');
}

// ============================================
// CRON - CHECK REMINDERS
// ============================================

async function handleCron(env) {
  var reminders = await getPendingReminders(env);

  for (var i = 0; i < reminders.length; i++) {
    await sendTelegram(env, env.TELEGRAM_CHAT_ID, 'Hatirlatma: ' + reminders[i].content);
    await markNotified(env, reminders[i].id);
  }
}

// ============================================
// CORS HEADERS
// ============================================

var corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};

// ============================================
// MAIN ROUTER
// ============================================

export default {
  async fetch(request, env, ctx) {
    var url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      // Chat endpoint
      if (url.pathname === '/api/chat' && request.method === 'POST') {
        var chatBody = await request.json();
        if (!chatBody.message) {
          return new Response(JSON.stringify({ error: 'Mesaj gerekli' }), {
            status: 400,
            headers: Object.assign({}, corsHeaders, { 'Content-Type': 'application/json' })
          });
        }
        var chatResponse = await handleChat(env, chatBody.message, 'web');
        return new Response(JSON.stringify({ response: chatResponse }), {
          headers: Object.assign({}, corsHeaders, { 'Content-Type': 'application/json' })
        });
      }

      // Get notes
      if (url.pathname === '/api/notes' && request.method === 'GET') {
        var noteType = url.searchParams.get('type');
        var notesList = await getNotes(env, noteType);
        return new Response(JSON.stringify(notesList), {
          headers: Object.assign({}, corsHeaders, { 'Content-Type': 'application/json' })
        });
      }

      // Add note
      if (url.pathname === '/api/notes' && request.method === 'POST') {
        var noteBody = await request.json();
        var noteResult = await addNote(env, noteBody.type || 'note', noteBody.content, noteBody.due_at);
        return new Response(JSON.stringify(noteResult), {
          headers: Object.assign({}, corsHeaders, { 'Content-Type': 'application/json' })
        });
      }

      // Delete note
      if (url.pathname.startsWith('/api/notes/') && request.method === 'DELETE') {
        var noteId = url.pathname.split('/').pop();
        await supabaseRequest(env, 'notes?id=eq.' + noteId, 'DELETE');
        return new Response(JSON.stringify({ success: true }), {
          headers: Object.assign({}, corsHeaders, { 'Content-Type': 'application/json' })
        });
      }

      // Get messages
      if (url.pathname === '/api/messages' && request.method === 'GET') {
        var msgLimit = url.searchParams.get('limit') || '50';
        var msgList = await getRecentMessages(env, parseInt(msgLimit));
        return new Response(JSON.stringify(msgList), {
          headers: Object.assign({}, corsHeaders, { 'Content-Type': 'application/json' })
        });
      }

      // Telegram webhook
      if (url.pathname === '/api/webhook/telegram' && request.method === 'POST') {
        return await handleTelegram(env, request);
      }

      // Health check
      if (url.pathname === '/' || url.pathname === '/health') {
        var timeNow = getCurrentTime();
        return new Response(JSON.stringify({
          status: 'ok',
          service: 'Jarvis AI Assistant',
          version: '2.0',
          time: timeNow.formatted,
          features: ['chat', 'notes', 'reminders', 'web-search', 'weather']
        }), {
          headers: Object.assign({}, corsHeaders, { 'Content-Type': 'application/json' })
        });
      }

      return new Response('Not Found', { status: 404, headers: corsHeaders });

    } catch (error) {
      console.error('Worker error:', error);
      return new Response(JSON.stringify({ error: 'Internal Server Error' }), {
        status: 500,
        headers: Object.assign({}, corsHeaders, { 'Content-Type': 'application/json' })
      });
    }
  },

  async scheduled(event, env, ctx) {
    await handleCron(env);
  }
};
