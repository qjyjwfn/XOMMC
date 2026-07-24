addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request))
})

// 用于在 Worker 内存中短暂缓存处理过的 message_id，防止瞬间并发重复转发
const processedMessages = new Set()

async function handleRequest(request) {
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 })
  }

  if (typeof TOKEN === 'undefined' || !TOKEN) {
    console.error('❌ 未读取到 TOKEN，请检查 CF 后台环境变量设置')
    return new Response('TOKEN is missing', { status: 500 })
  }

  try {
    const update = await request.json()
    
    // 只取 message 或 channel_post
    const msg = update.message || update.channel_post
    if (!msg) return new Response('OK')

    // 1. 防止相同 message_id 被瞬间重复触发
    const msgKey = `${msg.chat.id}:${msg.message_id}`
    if (processedMessages.has(msgKey)) {
      return new Response('OK')
    }

    // 2. 场景一：回复机器人发出的视频 -> 编辑文案
    if (msg.reply_to_message && msg.text && !msg.video && !msg.photo && !msg.animation && !msg.document) {
      processedMessages.add(msgKey)
      
      await fetch(`https://api.telegram.org/bot${TOKEN}/editMessageCaption`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: msg.chat.id,
          message_id: msg.reply_to_message.message_id,
          caption: msg.text
        })
      })
      return new Response('OK')
    }

    // 3. 场景二：无痕转发媒体（视频、图片、文件、动图等）
    const isVideoNote = !!msg.video_note
    const hasMedia = msg.video || msg.photo || msg.document || msg.animation || isVideoNote

    if (hasMedia) {
      // 记录已处理
      processedMessages.add(msgKey)
      
      // 内存控制：超过 100 条记录时自动清理，防止内存溢出
      if (processedMessages.size > 100) {
        const firstItem = processedMessages.values().next().value
        processedMessages.delete(firstItem)
      }

      const payload = {
        chat_id: msg.chat.id,
        from_chat_id: msg.chat.id,
        message_id: msg.message_id
      }

      // 只有非圆视频且自带文案时才传 caption
      if (!isVideoNote && msg.caption) {
        payload.caption = msg.caption
      }

      const res = await fetch(`https://api.telegram.org/bot${TOKEN}/copyMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      })

      const resData = await res.json()
      if (!resData.ok) {
        console.error('Telegram API 返回错误:', JSON.stringify(resData))
      }
    }
  } catch (err) {
    console.error('Worker 运行异常:', err.message)
  }

  return new Response('OK')
}
