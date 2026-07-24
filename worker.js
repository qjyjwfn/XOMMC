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
      const msg = update.message || update.channel_post
      if (!msg) return new Response('OK')

      // 自动初始化队列与锁表
      await env.DB.prepare(`CREATE TABLE IF NOT EXISTS album_queue (group_id TEXT, message_id INTEGER, raw_data TEXT)`).run()
      await env.DB.prepare(`CREATE TABLE IF NOT EXISTS album_lock (group_id TEXT PRIMARY KEY)`).run()


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


      // 场景 2：处理多媒体相册（保持原样复制）
      if (msg.media_group_id) {

        const groupId = msg.media_group_id
        const chatId = msg.chat.id


        // 1. 保存当前消息
        await env.DB.prepare(
          'INSERT INTO album_queue (group_id, message_id, raw_data) VALUES (?, ?, ?)'
        )
          .bind(
            groupId,
            msg.message_id,
            JSON.stringify(msg)
          )
          .run()


        // 2. 创建锁，避免重复处理
        const lockRes = await env.DB.prepare(
          'INSERT OR IGNORE INTO album_lock (group_id) VALUES (?)'
        )
          .bind(groupId)
          .run()


        // 已经有其它实例处理
        if (lockRes.meta && lockRes.meta.changes === 0) {
          return new Response('OK')
        }


        // 等待相册全部消息进入
        await new Promise(resolve => setTimeout(resolve, 1500))


        // 3. 获取完整相册消息
        const { results: rows } = await env.DB.prepare(
          'SELECT message_id FROM album_queue WHERE group_id = ? ORDER BY message_id ASC'
        )
          .bind(groupId)
          .all()


        // 4. 清理
        await env.DB.prepare(
          'DELETE FROM album_queue WHERE group_id = ?'
        )
          .bind(groupId)
          .run()

        await env.DB.prepare(
          'DELETE FROM album_lock WHERE group_id = ?'
        )
          .bind(groupId)
          .run()


        if (!rows || rows.length === 0) {
          return new Response('OK')
        }


        // 5. 按 Telegram 原消息逐条复制
        for (const row of rows) {

          await fetch(
            `https://api.telegram.org/bot${env.TOKEN}/copyMessage`,
            {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({
                chat_id: chatId,
                from_chat_id: chatId,
                message_id: row.message_id
              })
            }
          )

        }


        return new Response('OK')
      }


      // 场景 3：单条媒体消息
      const hasMedia =
        msg.video ||
        msg.video_note ||
        msg.photo ||
        msg.animation ||
        msg.document


      if (hasMedia) {

        await fetch(
          `https://api.telegram.org/bot${env.TOKEN}/copyMessage`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              chat_id: msg.chat.id,
              from_chat_id: msg.chat.id,
              message_id: msg.message_id
            })
          }
        )

      }

    } catch (err) {
      console.error(
        'Worker 运行异常:',
        err.message
      )
    }


    return new Response('OK')
  }
}