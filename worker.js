export default {
  async fetch(request, env, ctx) {
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 })
    }

    if (!env.TOKEN) {
      return new Response('TOKEN is missing', { status: 500 })
    }

    if (!env.DB) {
      return new Response('DB binding is missing', { status: 500 })
    }

    try {
      const update = await request.json()
      const msg = update.message || update.channel_post
      if (!msg) return new Response('OK')

      // 场景 1：长按回复 Bot 发出的消息，并发送纯文本 -> 修改其简介/文案
      if (msg.reply_to_message && msg.text && !msg.video && !msg.photo && !msg.animation && !msg.document) {
        await fetch(`https://api.telegram.org/bot${env.TOKEN}/editMessageCaption`, {
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

      // 场景 2：处理多媒体相册（海报 + 视频组合）
      if (msg.media_group_id) {
        const groupId = msg.media_group_id
        const now = Date.now()

        // 将当前消息存入 D1 数据库
        await env.DB.prepare('INSERT INTO media_queue (group_id, data, created_at) VALUES (?, ?, ?)')
          .bind(groupId, JSON.stringify(msg), now)
          .run()

        // 等待 1.5 秒，让并发进来的其他海报和视频全部写入数据库
        await new Promise(resolve => setTimeout(resolve, 1500))

        // 加锁机制：查询当前组最早的一条记录，只有当“我是第一条”时才由我负责打包发送
        const firstItem = await env.DB.prepare('SELECT created_at FROM media_queue WHERE group_id = ? ORDER BY created_at ASC LIMIT 1')
          .bind(groupId)
          .first()

        if (!firstItem || firstItem.created_at !== now) {
          return new Response('OK')
        }

        // 获取该相册组的所有媒体数据
        const { results: rows } = await env.DB.prepare('SELECT data FROM media_queue WHERE group_id = ?')
          .bind(groupId)
          .all()

        // 清理数据库中的该组缓存
        await env.DB.prepare('DELETE FROM media_queue WHERE group_id = ?').bind(groupId).run()

        if (!rows || rows.length === 0) return new Response('OK')

        const messages = rows.map(r => JSON.parse(r.data))
        messages.sort((a, b) => a.message_id - b.message_id)

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
            if (i === 0 && globalCaption) {
              mediaItem.caption = globalCaption
            }
            mediaArray.push(mediaItem)
          }
        }

        if (mediaArray.length > 0) {
          await fetch(`https://api.telegram.org/bot${env.TOKEN}/sendMediaGroup`, {
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

      // 场景 3：单条媒体消息（无相册分组）
      const hasMedia = msg.video || msg.video_note || msg.photo || msg.animation || msg.document
      if (hasMedia) {
        await fetch(`https://api.telegram.org/bot${env.TOKEN}/copyMessage`, {
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
}
