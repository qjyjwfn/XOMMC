addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request))
})

async function handleRequest(request) {
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 })
  }

  if (typeof TOKEN === 'undefined' || !TOKEN) {
    return new Response('TOKEN is missing', { status: 500 })
  }

  try {
    const update = await request.json()
    const msg = update.message || update.channel_post
    if (!msg) return new Response('OK')

    // 场景 1：长按回复 Bot 的消息，并发送纯文本 -> 修改其简介/文案
    if (msg.reply_to_message && msg.text && !msg.video && !msg.photo && !msg.animation && !msg.document) {
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

    // 场景 2：原样无痕转发媒体（带防并发和自动重试）
    const hasMedia = msg.video || msg.video_note || msg.photo || msg.animation || msg.document

    if (hasMedia) {
      const payload = {
        chat_id: msg.chat.id,
        from_chat_id: msg.chat.id,
        message_id: msg.message_id
      }

      let retryCount = 0
      let success = false

      // 最多尝试 3 次，防止 Telegram 并发限制导致的丢资源
      while (retryCount < 3 && !success) {
        // 如果是重试，随机延迟 0.5 ~ 1.5 秒错开高峰
        if (retryCount > 0) {
          await new Promise(resolve => setTimeout(resolve, 500 + Math.random() * 1000))
        }

        const res = await fetch(`https://api.telegram.org/bot${TOKEN}/copyMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        })

        const resData = await res.json()

        if (resData.ok) {
          success = true
        } else if (resData.error_code === 429) {
          // 429 说明请求太快被 Telegram 拦截，准备下一轮重试
          retryCount++
        } else {
          // 遇到其他硬性报错（比如版权保护），直接通过 Bot 发送文字通知你
          await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: msg.chat.id,
              text: `❌ 某条媒体转发失败！\n原因: ${resData.description}`
            })
          })
          break
        }
      }
    }
  } catch (err) {
    console.error('Worker 运行异常:', err.message)
  }

  return new Response('OK')
}
