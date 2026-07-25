export default {
  async fetch(request, env, ctx) {

    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 })
    }

    if (!env.TOKEN || !env.DB) {
      return new Response('Configuration missing', { status: 500 })
    }

    try {
      const update = await request.json()
      // 兼容频道(channel_post)和群聊/私聊(message)
      const msg = update.message || update.channel_post

      if (!msg) {
        return new Response('OK')
      }

      // ==================
      // 1. 回复修改简介
      // ==================
      if (
        msg.reply_to_message &&
        msg.text &&
        !msg.video &&
        !msg.photo &&
        !msg.animation &&
        !msg.document
      ) {
        ctx.waitUntil(
          fetch(`https://api.telegram.org/bot${env.TOKEN}/editMessageCaption`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: msg.chat.id,
              message_id: msg.reply_to_message.message_id,
              caption: msg.text
            })
          }).catch(err => console.error('修改简介异常:', err.message))
        )
        return new Response('OK')
      }

      // ==================
      // 2. 媒体组 (Album) 处理
      // ==================
      if (msg.media_group_id) {
        const groupId = msg.media_group_id

        // 将当前消息存入队列
        await env.DB.prepare(`
          INSERT INTO album_queue (group_id, message_id) VALUES (?, ?)
        `).bind(groupId, msg.message_id).run()

        // 放入后台任务处理：合并复制并删除原媒体组
        ctx.waitUntil(processAlbumInBackground(groupId, msg.chat.id, env))

        return new Response('OK')
      }

      // ==================
      // 3. 单媒体处理 (视频/图片/文件等)
      // ==================
      const hasMedia =
        msg.video ||
        msg.video_note ||
        msg.photo ||
        msg.animation ||
        msg.document

      if (hasMedia) {
        ctx.waitUntil(
          (async () => {
            try {
              // A. 复制消息 (这会完美保留排版，并剥离转发来源)
              const copyRes = await fetch(`https://api.telegram.org/bot${env.TOKEN}/copyMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  chat_id: msg.chat.id,
                  from_chat_id: msg.chat.id,
                  message_id: msg.message_id
                })
              })

              // B. 复制成功后，马上删除那条带有来源的旧消息
              if (copyRes.ok) {
                await fetch(`https://api.telegram.org/bot${env.TOKEN}/deleteMessage`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    chat_id: msg.chat.id,
                    message_id: msg.message_id
                  })
                })
              }
            } catch (err) {
              console.error('单媒体处理异常:', err.message)
            }
          })()
        )
      }

    } catch (err) {
      console.error('Worker运行异常:', err.message)
    }

    return new Response('OK')
  }
}

/**
 * 专门处理 Album 媒体组合并、复制及清理的后台任务
 */
async function processAlbumInBackground(groupId, chatId, env) {
  try {
    // 抢占锁，保证多张图片并发时只有一个 Worker 负责发送
    const lock = await env.DB.prepare(`
      INSERT OR IGNORE INTO album_lock(group_id) VALUES(?)
    `).bind(groupId).run()

    if (lock.meta && lock.meta.changes === 0) {
      return // 已有任务在处理该组
    }

    // 等待 3 秒，让同一个 album 的剩余图片入库
    await new Promise(r => setTimeout(r, 3000))

    // 查出这 3 秒内收集到的该组所有 message_id
    const { results: rows } = await env.DB.prepare(`
      SELECT message_id FROM album_queue
      WHERE group_id=? ORDER BY message_id ASC
    `).bind(groupId).all()

    // 清理数据库队列和锁
    await env.DB.prepare(`DELETE FROM album_queue WHERE group_id=?`).bind(groupId).run()
    await env.DB.prepare(`DELETE FROM album_lock WHERE group_id=?`).bind(groupId).run()

    if (!rows || rows.length === 0) return

    const messageIds = rows.map(r => r.message_id)

    // A. 批量复制原媒体组 (完美保留所有图片顺序和文字排版)
    const copyRes = await fetch(`https://api.telegram.org/bot${env.TOKEN}/copyMessages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        from_chat_id: chatId,
        message_ids: messageIds
      })
    })

    // B. 如果复制成功，使用 deleteMessages 批量删除原有的带转发标签的媒体组
    if (copyRes.ok) {
      await fetch(`https://api.telegram.org/bot${env.TOKEN}/deleteMessages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          message_ids: messageIds
        })
      })
    }

  } catch (err) {
    console.error('后台处理媒体组异常:', err.message)
  }
}