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

  if (typeof KV === 'undefined') {
    return new Response('KV binding is missing, please bind KV as "KV"', { status: 500 })
  }

  try {
    const update = await request.json()
    const msg = update.message || update.channel_post
    if (!msg) return new Response('OK')

    // 场景 1：长按回复 Bot 发出的消息，并发送纯文本 -> 修改其简介/文案
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

    // 场景 2：处理多媒体相册（带有 media_group_id，如海报 + 视频组合）
    if (msg.media_group_id) {
      const groupId = msg.media_group_id
      const key = `mg_${groupId}_${msg.message_id}`
      
      // 将当前消息存入 KV，有效期 60 秒
      await KV.put(key, JSON.stringify(msg), { expirationTtl: 60 })

      // 等待 1.5 秒，让并发进来的其他海报和视频陆续写入 KV
      await new Promise(resolve => setTimeout(resolve, 1500))

      // 加锁：确保多个并发请求中只有第一个执行打包发送，防止重复刷屏
      const lockKey = `lock_${groupId}`
      const locked = await KV.get(lockKey)
      if (locked) {
        return new Response('OK')
      }
      await KV.put(lockKey, '1', { expirationTtl: 60 })

      // 读取该组所有消息
      const list = await KV.list({ prefix: `mg_${groupId}_` })
      const messages = []
      for (const k of list.keys) {
        const val = await KV.get(k.name)
        if (val) {
          messages.push(JSON.parse(val))
        }
      }

      if (messages.length === 0) return new Response('OK')

      // 按原消息 ID 排序，保证海报在前、视频在后
      messages.sort((a, b) => a.message_id - b.message_id)

      // 组装 sendMediaGroup 所需的媒体数组
      const mediaArray = []
      let globalCaption = ''

      for (let i = 0; i < messages.length; i++) {
        const m = messages[i]
        if (m.caption && !globalCaption) {
          globalCaption = m.caption
        }

        let fileId = ''
        let type = 'photo'

        if (m.video) {
          fileId = m.video.file_id
          type = 'video'
        } else if (m.photo) {
          fileId = m.photo[m.photo.length - 1].file_id
          type = 'photo'
        } else if (m.document) {
          fileId = m.document.file_id
          type = 'document'
        } else if (m.animation) {
          fileId = m.animation.file_id
          type = 'animation'
        }

        if (fileId) {
          const mediaItem = { type, media: fileId }
          // 将文案完整挂载在相册的第一项上
          if (i === 0 && globalCaption) {
            mediaItem.caption = globalCaption
          }
          mediaArray.push(mediaItem)
        }
      }

      if (mediaArray.length > 0) {
        await fetch(`https://api.telegram.org/bot${TOKEN}/sendMediaGroup`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: msg.chat.id,
            media: mediaArray
          })
        })
      }

      return new Response('OK')
    }

    // 场景 3：单条媒体消息（如单独的视频或图片，无相册分组）
    const hasMedia = msg.video || msg.video_note || msg.photo || msg.animation || msg.document
    if (hasMedia) {
      await fetch(`https://api.telegram.org/bot${TOKEN}/copyMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: msg.chat.id,
          from_chat_id: msg.chat.id,
          message_id: msg.message_id
        })
      })
    }
  } catch (err) {
    console.error('Worker 运行异常:', err.message)
  }

  return new Response('OK')
}
