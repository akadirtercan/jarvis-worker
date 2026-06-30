// ============================================
// JARVIS - Cloudflare Worker Backend
// Kadir Tercan - Kişisel AI Asistan
// ============================================

const SYSTEM_PROMPT_BASE = `Sen Jarvis'sin — Kadir'in kişisel AI asistanı. Türkçe konuşursun, samimi ama profesyonelsin.

KURALLAR:
- Kısa ve öz cevaplar ver, gereksiz uzatma
- Teknik konularda (TwinCAT 3, Beckhoff, Siemens TIA Portal, ABB OmniCore, FANUC) detaylı yardım edebilirsin
- Kullanıcı not almak, görev eklemek veya hatırlatma kurmak istediğinde uygun fonksiyonu çağır
- Günlük muhabbette samimi ol, emoji kullanabilirsin
- Fitness, araba (1995 Corolla XLi), İngilizce öğrenme konularında da yardımcı ol

FONKSİYONLAR:
Kullanıcı aşağıdaki işlemleri istediğinde, cevabının içine JSON formatında komut yerleştir:
- Not almak isterse: {"action":"addNote","content":"not içeriği"}
- Görev eklemek isterse: {"action":"addTask","content":"görev içeriği"}
- Hatırlatma kurmak isterse: {"action":"addReminder","content":"hatırlatma içeriği","due_at":"ISO tarih"}
- Notları görmek isterse: {"action":"getNotes"}
- Görevleri görmek isterse: {"action":"getTasks"}
- Görevi tamamlamak isterse: {"action":"completeTask","content":"görev açıklaması"}
- Silmek isterse: {"action":"deleteNote","content":"silinecek not açıklaması"}

ÖNEMLI: Fonksiyon çağrısı yaparken, JSON'ı cevap metninin SONUNA, --- ayracından sonra koy.
Örnek:
Tabii, notu kaydettim!
---
{"action":"addNote","content":"AX5125 PDO mapping kontrol edilecek"}`;

// ============================================
// SUPABASE HELPERS
// ============================================

async function supabaseRequest(env, path, method = 'GET', body = null) {
  const opts = {
    method,
    headers: {
      'apikey': env.SUPABASE_KEY,
      'Authorization': `Bearer ${env.SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': method === 'POST' ? 'return=representation' : undefined
    }
  };
  if (body) opts.body = JSON.stringify(body);
  // Clean undefined headers
  Object.keys(opts.headers).forEach(k => opts.headers[k] === undefined && delete opts.headers[k]);
  
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, opts);
  if (!res.ok) {
    const err = await res.text();
    console.error('Supabase error:', err);
    return null;
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function getMemory(env) {
  const data = await supabaseRequest(env, 'memory?select=summary&limit=1');
  return data && data.length > 0 ? data[0].summary : '';
}

async function updateMemory(env, summary) {
  // Update all rows (there's only one)
  await supabaseRequest(env, 'memory', 'PATCH', { summary, updated_at: new Date().toISOString() });
}

async function getRecentMessages(env, limit = 15) {
  const data = await supabaseRequest(env, `messages?select=role,content,created_at&order=created_at.desc&limit=${limit}`);
  return data ? data.reverse() : [];
}

async function saveMessage(env, role, content, source = 'web') {
  await supabaseRequest(env, 'messages', 'POST', { role, content, source });
}

async function getMessageCount(env) {
  const data = await supabaseRequest(env, 'messages?select=id&order=created_at.desc&limit=100');
  return data ? data.length : 0;
}

async function getNotes(env, type = null) {
  let path = 'notes?select=*&order=created_at.desc';
  if (type) path += `&type=eq.${type}`;
  path += '&is_done=eq.false';
  return await supabaseRequest(env, path) || [];
}

async function addNote(env, type, content, due_at = null) {
  const body = { type, content };
  if (due_at) body.due_at = due_at;
  return await supabaseRequest(env, 'notes', 'POST', body);
}

async function completeTask(env, content) {
  // Find matching task
  const notes = await getNotes(env, 'task');
  const match = notes.find(n => n.content.toLowerCase().includes(content.toLowerCase()));
  if (match) {
    await supabaseRequest(env, `notes?id=eq.${match.id}`, 'PATCH', { is_done: true });
    return true;
  }
  return false;
}

async function deleteNote(env, content) {
  const notes = await getNotes(env);
  const match = notes.find(n => n.content.toLowerCase().includes(content.toLowerCase()));
  if (match) {
    await supabaseRequest(env, `notes?id=eq.${match.id}`, 'DELETE');
    return true;
  }
  return false;
}

async function getPendingReminders(env) {
  const now = new Date().toISOString();
  const data = await supabaseRequest(env, `notes?select=*&type=eq.reminder&notified=eq.false&due_at=lte.${now}`);
  return data || [];
}

async function markNotified(env, id) {
  await supabaseRequest(env, `notes?id=eq.${id}`, 'PATCH', { notified: true });
}

// ============================================
// GROQ API
// ============================================

async function askGroq(env, messages) {
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.GROQ_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      messages,
      max_tokens: 2048,
      temperature: 0.7
    })
  });

  if (!res.ok) {
    const err = await res.text();
    console.error('Groq error:', err);
    return 'Üzgünüm, şu an AI servisine ulaşamıyorum. Biraz sonra tekrar dene.';
  }

  const data = await res.json();
  return data.choices[0].message.content;
}

// ============================================
// PROCESS AI ACTIONS
// ============================================

async function processActions(env, aiResponse) {
  // Check if response contains action JSON after ---
  const parts = aiResponse.split('---');
  if (parts.length < 2) return { cleanResponse: aiResponse, actionResults: [] };

  const cleanResponse = parts[0].trim();
  const actionPart = parts.slice(1).join('---').trim();
  const actionResults = [];

  try {
    const action = JSON.parse(actionPart);
    
    switch (action.action) {
      case 'addNote':
        await addNote(env, 'note', action.content);
        actionResults.push(`Not kaydedildi: ${action.content}`);
        break;
      
      case 'addTask':
        await addNote(env, 'task', action.content);
        actionResults.push(`Görev eklendi: ${action.content}`);
        break;
      
      case 'addReminder':
        await addNote(env, 'reminder', action.content, action.due_at);
        actionResults.push(`Hatırlatma kuruldu: ${action.content}`);
        break;
      
      case 'getNotes': {
        const notes = await getNotes(env);
        if (notes.length === 0) {
          actionResults.push('Henüz hiç notun yok.');
        } else {
          const list = notes.map((n, i) => `${i + 1}. [${n.type}] ${n.content}`).join('\n');
          actionResults.push(`Notların:\n${list}`);
        }
        break;
      }
      
      case 'getTasks': {
        const tasks = await getNotes(env, 'task');
        if (tasks.length === 0) {
          actionResults.push('Aktif görevin yok, harika!');
        } else {
          const list = tasks.map((t, i) => `${i + 1}. ${t.content}`).join('\n');
          actionResults.push(`Aktif görevlerin:\n${list}`);
        }
        break;
      }
      
      case 'completeTask': {
        const success = await completeTask(env, action.content);
        actionResults.push(success ? `Görev tamamlandı: ${action.content}` : 'Eşleşen görev bulunamadı.');
        break;
      }
      
      case 'deleteNote': {
        const success = await deleteNote(env, action.content);
        actionResults.push(success ? `Silindi: ${action.content}` : 'Eşleşen kayıt bulunamadı.');
        break;
      }
    }
  } catch (e) {
    // Not valid JSON, return as is
    return { cleanResponse: aiResponse, actionResults: [] };
  }

  return { cleanResponse, actionResults };
}

// ============================================
// MEMORY REFRESH (every ~20 messages)
// ============================================

async function maybeRefreshMemory(env) {
  const count = await getMessageCount(env);
  if (count > 0 && count % 20 === 0) {
    const messages = await getRecentMessages(env, 30);
    const msgText = messages.map(m => `${m.role}: ${m.content}`).join('\n');
    
    const summary = await askGroq(env, [
      {
        role: 'system',
        content: 'Aşağıdaki konuşma geçmişinden kullanıcı hakkında önemli bilgileri Türkçe olarak özetle. Kısa ve madde madde yaz. İş, hobiler, projeler, tercihler gibi kalıcı bilgilere odaklan. Maksimum 500 kelime.'
      },
      {
        role: 'user',
        content: msgText
      }
    ]);

    const currentMemory = await getMemory(env);
    const merged = currentMemory + '\n\n[Güncelleme]: ' + summary;
    // Keep it under ~1500 chars
    const trimmed = merged.length > 1500 ? merged.slice(-1500) : merged;
    await updateMemory(env, trimmed);
  }
}

// ============================================
// MAIN CHAT HANDLER
// ============================================

async function handleChat(env, userMessage, source = 'web') {
  // 1. Get memory and recent messages
  const [memory, recentMessages] = await Promise.all([
    getMemory(env),
    getRecentMessages(env, 15)
  ]);

  // 2. Build system prompt with memory
  let systemPrompt = SYSTEM_PROMPT_BASE;
  if (memory) {
    systemPrompt += `\n\nKADIR HAKKINDA BİLDİKLERİN:\n${memory}`;
  }

  // 3. Build messages array for Groq
  const groqMessages = [
    { role: 'system', content: systemPrompt }
  ];

  // Add recent messages for context
  for (const msg of recentMessages) {
    groqMessages.push({ role: msg.role, content: msg.content });
  }

  // Add current message
  groqMessages.push({ role: 'user', content: userMessage });

  // 4. Ask Groq
  const aiResponse = await askGroq(env, groqMessages);

  // 5. Process any actions in the response
  const { cleanResponse, actionResults } = await processActions(env, aiResponse);

  // 6. Build final response
  let finalResponse = cleanResponse;
  if (actionResults.length > 0) {
    finalResponse = cleanResponse + '\n\n' + actionResults.join('\n');
  }

  // 7. Save messages
  await saveMessage(env, 'user', userMessage, source);
  await saveMessage(env, 'assistant', finalResponse, source);

  // 8. Maybe refresh memory
  await maybeRefreshMemory(env);

  return finalResponse;
}

// ============================================
// TELEGRAM HANDLER
// ============================================

async function sendTelegram(env, chatId, text) {
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: text,
      parse_mode: 'Markdown'
    })
  });
}

async function handleTelegram(env, request) {
  const body = await request.json();

  if (!body.message || !body.message.text) {
    return new Response('ok');
  }

  const chatId = body.message.chat.id;
  const text = body.message.text;

  // Security: only respond to our chat
  if (chatId.toString() !== env.TELEGRAM_CHAT_ID) {
    return new Response('ok');
  }

  // Handle /start command
  if (text === '/start') {
    await sendTelegram(env, chatId, 'Merhaba Kadir! Ben Jarvis, kişisel asistanın. 🤖\n\nBana her şeyi sorabilirsin!');
    return new Response('ok');
  }

  // Handle /export command
  if (text === '/export') {
    const notes = await getNotes(env);
    const tasks = await getNotes(env, 'task');
    if (notes.length === 0 && tasks.length === 0) {
      await sendTelegram(env, chatId, 'Henüz kayıtlı not veya görevin yok.');
    } else {
      let msg = '*📋 Notların ve Görevlerin:*\n\n';
      if (notes.length > 0) {
        msg += '*Notlar:*\n' + notes.filter(n => n.type === 'note').map((n, i) => `${i + 1}. ${n.content}`).join('\n');
        msg += '\n\n';
      }
      if (tasks.length > 0) {
        msg += '*Görevler:*\n' + tasks.map((t, i) => `${i + 1}. ${t.content}`).join('\n');
      }
      await sendTelegram(env, chatId, msg);
    }
    return new Response('ok');
  }

  // Regular chat
  const response = await handleChat(env, text, 'telegram');
  await sendTelegram(env, chatId, response);

  return new Response('ok');
}

// ============================================
// CRON - CHECK REMINDERS
// ============================================

async function handleCron(env) {
  const reminders = await getPendingReminders(env);
  
  for (const reminder of reminders) {
    await sendTelegram(env, env.TELEGRAM_CHAT_ID, `⏰ *Hatırlatma:* ${reminder.content}`);
    await markNotified(env, reminder.id);
  }
}

// ============================================
// CORS HEADERS
// ============================================

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

// ============================================
// MAIN ROUTER
// ============================================

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      // Chat endpoint (Web UI)
      if (url.pathname === '/api/chat' && request.method === 'POST') {
        const { message } = await request.json();
        if (!message) {
          return new Response(JSON.stringify({ error: 'Mesaj gerekli' }), {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          });
        }

        const response = await handleChat(env, message, 'web');
        return new Response(JSON.stringify({ response }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      // Get notes
      if (url.pathname === '/api/notes' && request.method === 'GET') {
        const type = url.searchParams.get('type');
        const notes = await getNotes(env, type);
        return new Response(JSON.stringify(notes), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      // Add note
      if (url.pathname === '/api/notes' && request.method === 'POST') {
        const { type, content, due_at } = await request.json();
        const result = await addNote(env, type || 'note', content, due_at);
        return new Response(JSON.stringify(result), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      // Delete note
      if (url.pathname.startsWith('/api/notes/') && request.method === 'DELETE') {
        const id = url.pathname.split('/').pop();
        await supabaseRequest(env, `notes?id=eq.${id}`, 'DELETE');
        return new Response(JSON.stringify({ success: true }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      // Get messages (chat history)
      if (url.pathname === '/api/messages' && request.method === 'GET') {
        const limit = url.searchParams.get('limit') || 50;
        const messages = await getRecentMessages(env, parseInt(limit));
        return new Response(JSON.stringify(messages), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      // Telegram webhook
      if (url.pathname === '/api/webhook/telegram' && request.method === 'POST') {
        return await handleTelegram(env, request);
      }

      // Health check
      if (url.pathname === '/' || url.pathname === '/health') {
        return new Response(JSON.stringify({ 
          status: 'ok', 
          service: 'Jarvis AI Assistant',
          version: '1.0'
        }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      return new Response('Not Found', { status: 404, headers: corsHeaders });

    } catch (error) {
      console.error('Worker error:', error);
      return new Response(JSON.stringify({ error: 'Internal Server Error' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
  },

  // Cron trigger for reminders
  async scheduled(event, env, ctx) {
    await handleCron(env);
  }
};
