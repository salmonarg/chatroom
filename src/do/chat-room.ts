import { DurableObject } from 'cloudflare:workers'
import { jwtVerify } from 'jose'
import { Bindings, Message } from '../types'

export class ChatRoom extends DurableObject {
    state: any
    env: Bindings

    constructor(state: any, env: Bindings) {
        super(state, env)
        this.state = state
        this.env = env
    }

    async fetch(request: Request) {
        const url = new URL(request.url)

        // handle internal user list requests
        if (url.pathname === "/users") {
            const uniqueUsers = new Map()   
            this.state.getWebSockets().forEach((session: any) => {
                const userData = session.deserializeAttachment()
                if (userData) {
                    if (!uniqueUsers.has(userData.uid)) {
                        uniqueUsers.set(userData.uid, {
                            username: userData.username,
                            uid: userData.uid,
                            role: userData.role
                        })
                    }
                }
            })
            return new Response(JSON.stringify(Array.from(uniqueUsers.values())), {
                headers: { "Content-Type": "application/json" }
            })
        }
        if (url.pathname === "/history") {
            const cursor = url.searchParams.get("cursor")
            return this.getHistory(cursor)
        }
        if (url.pathname === "/export") {
            const limitParam = url.searchParams.get("limit")
            return this.exportHistory(limitParam)
        }
        if (request.headers.get("Upgrade") !== "websocket") {
            return new Response("Expected Upgrade: websocket", { status: 426 })
        }
        let username, role, uid
        try {
            const cookieHeader = request.headers.get("Cookie")
            if (!cookieHeader) throw new Error("Missing cookie header")
        
            // Simple cookie parse
            const getCookie = (name: string) => {
                const value = `; ${cookieHeader}`
                const parts = value.split(`; ${name}=`)
                if (parts.length === 2) return parts.pop()?.split(';').shift()
            }
            const sessionToken = getCookie('session')

            if (!sessionToken) throw new Error("Missing session cookie")
            if (!this.env.JWT_SECRET) {
                throw new Error("Server configuration error: JWT_SECRET missing")
            }
            const JWT_SECRET = new TextEncoder().encode(this.env.JWT_SECRET)
            const { payload } = await jwtVerify(sessionToken, JWT_SECRET)      
            if (!payload.uid || !payload.username) {
                throw new Error("Invalid session content")
            }

            username = payload.username
            role = payload.role || "user"
            uid = payload.uid

        } catch (e: any) {
            console.log("WebSocket Auth Failed:", e.message)
            return new Response("Unauthorized: Please login to access chatrooms", { status: 401 })
        }

        let roomName = "unknown"
        const pathParts = url.pathname.split("/")
        if (pathParts.length >= 3 && pathParts[1] === "websocket") {
            roomName = pathParts[2]
        }

        const { 0: client, 1: server } = new WebSocketPair()
        await this.handleSession(server as unknown as WebSocket, username, role, uid, roomName)
        return new Response(null, { status: 101, webSocket: client })
    }

    async handleSession(socket: any, username: any, role: any, uid: any, roomName: any) {
        this.state.acceptWebSocket(socket)
        socket.serializeAttachment({ username, role, uid, roomName })
        await this.pushRecentHistory(socket)
    }

    async webSocketMessage(ws: any, msg: string | ArrayBuffer) {
        const userData = ws.deserializeAttachment()
        if (!userData) return

        const data = typeof msg === "string" ? msg : new TextDecoder().decode(msg)

        if (data.startsWith("/")) {
            console.log(`Received command from ${userData.username}: ${data}`)
            const args = data.split(" ")
            const command = args[0]

            if (command === "/clear") {
                if (userData.role !== 'admin') {
                        ws.send(JSON.stringify({
                            sender_username: "system",
                            text: "permission denied.",
                            timestamp: Date.now()
                        }))
                        return
                }

                const list = await this.state.storage.list({ prefix: "msg-" })
                const keys = Array.from(list.keys())
                if (keys.length > 0) {
                    await this.state.storage.delete(keys)
                }
        
                const clearMsg = {
                    msg_id: this.generateMsgId(),
                    sender_username: "system",
                    sender_uid: "00001",
                    text: `chat history cleared by ${userData.username}(${userData.uid}).`,
                    timestamp: Date.now(),
                    channel: userData.roomName
                }
                const clearMsgStr = JSON.stringify(clearMsg)
                this.broadcast(clearMsgStr)
                this.saveMessage(clearMsg)
                return 
            }

            if (command === "/wipe") {
                if (userData.role !== 'admin') {
                        ws.send(JSON.stringify({
                            sender_username: "system",
                            text: "permission denied.",
                            timestamp: Date.now()
                        }))
                        return
                }

                const targetMsgId = args[1]
                if (!targetMsgId || !targetMsgId.startsWith("msg-")) {
                    ws.send(JSON.stringify({
                        sender_username: "system",
                        text: "usage: /wipe <msg-id>",
                        timestamp: Date.now()
                    }))
                    return
                }

                await this.state.storage.delete(targetMsgId)

                const wipeMsg = {
                    sender_username: "system",
                    sender_uid: "00001",
                    channel: userData.roomName,
                    text: `message ${targetMsgId} wiped by ${userData.username}.`,
                    timestamp: Date.now()
                }

                ws.send(JSON.stringify(wipeMsg))
                return
            }

            if (command === "/del") {
                const targetMsgId = args[1]
                if (!targetMsgId || !targetMsgId.startsWith("msg-")) {
                     ws.send(JSON.stringify({
                        sender_username: "system",
                        text: "usage: /del <msg-id>",
                        timestamp: Date.now()
                    }))
                    return
                }

                const msgRecord: any = await this.state.storage.get(targetMsgId)
                if (!msgRecord) {
                     ws.send(JSON.stringify({
                        sender_username: "system",
                        text: "message not found.",
                        timestamp: Date.now()
                    }))
                    return
                }

                if (msgRecord.sender_uid !== userData.uid) {
                     ws.send(JSON.stringify({
                        sender_username: "system",
                        text: "permission denied. you can only delete your own messages.",
                        timestamp: Date.now()
                    }))
                    return
                }

                const originalText = msgRecord.text
                const originalTime = msgRecord.timestamp

                msgRecord.text = "<deleted>"
                msgRecord.is_deleted = true
                await this.state.storage.put(targetMsgId, msgRecord)

                const delNotify = {
                    sender_username: "system",
                    sender_uid: "00001",
                    channel: userData.roomName,
                    text: `message ${targetMsgId} (${originalText}) from ${new Date(originalTime).toISOString()} was deleted.`,
                    timestamp: Date.now()
                }
                
                const notifyStr = JSON.stringify(delNotify)
                ws.send(notifyStr)
                
                this.broadcast(JSON.stringify(msgRecord))
                return
            }

            if (command === "/censor") {
                if (userData.role !== 'admin') {
                     ws.send(JSON.stringify({
                        sender_username: "system",
                        text: "permission denied.",
                        timestamp: Date.now()
                    }))
                    return
                }

                const targetMsgId = args[1]
                const reason = args.slice(2).join(" ")

                if (!targetMsgId || !targetMsgId.startsWith("msg-")) {
                     ws.send(JSON.stringify({
                        sender_username: "system",
                        text: "usage: /censor <msg-id> <reason>",
                        timestamp: Date.now()
                    }))
                    return
                }

                const msgRecord: any = await this.state.storage.get(targetMsgId)
                if (!msgRecord) {
                     ws.send(JSON.stringify({
                        sender_username: "system",
                        text: "message not found.",
                        timestamp: Date.now()
                    }))
                    return
                }

                const censorText = reason 
                    ? `<censored by ${userData.username}: ${reason}>` 
                    : `<censored by ${userData.username}>`
                
                const originalText = msgRecord.text
                msgRecord.text = censorText
                msgRecord.is_censored = true

                await this.state.storage.put(targetMsgId, msgRecord)

                const censorNotify = {
                    sender_username: "system",
                    sender_uid: "00001",
                    channel: userData.roomName,
                    text: `message ${targetMsgId} (${originalText}) was censored by ${userData.username}.`,
                    timestamp: Date.now()
                }
                
                const notifyStr = JSON.stringify(censorNotify)
                ws.send(notifyStr)

                this.broadcast(JSON.stringify(msgRecord))
                return
            }

            if (command === "/insert") {
                if (userData.role !== 'admin') {
                     ws.send(JSON.stringify({
                        sender_username: "system",
                        text: "permission denied.",
                        timestamp: Date.now()
                    }))
                    return
                }

                const targetTimestamp = parseInt(args[1])
                const text = args.slice(2).join(" ")

                if (isNaN(targetTimestamp) || !text) {
                     ws.send(JSON.stringify({
                        sender_username: "system",
                        text: "usage: /insert <timestamp> <text>",
                        timestamp: Date.now()
                    }))
                    return
                }

                const msgId = this.generateMsgId(targetTimestamp)
                const msgRecord = {
                    msg_id: msgId,
                    sender_username: userData.username,
                    sender_uid: userData.uid,
                    channel: userData.roomName,
                    timestamp: targetTimestamp,
                    text: text
                }

                await this.saveMessage(msgRecord)
                this.broadcast(JSON.stringify(msgRecord))
                return
            }

            if (command === "/help") {
                let helpText = "Commands:<br>"
                helpText += "/del <msg-id> (soft delete your own message)<br>"
                helpText += "/save (save chat history in this room)<br>"
                helpText += "<br>Typeset:<br>"
                helpText += "&lt;br&gt; (line break)<br>"
                helpText += "&lt;b&gt;text&lt;/b&gt; (bold text)<br>"
                helpText += "&lt;a href=\"url\"&gt;text&lt;/a&gt; (link)<br>"

                if (userData.role === 'admin') {
                    helpText += "<br>Admin Commands:<br>"
                    helpText += "/clear (clear all messages in this room)<br>"
                    helpText += "/wipe <msg-id> (permanently remove a message)<br>"
                    helpText += "/censor <msg-id> <reason> (censor a message with optional reason)<br>"
                    helpText += "/insert <timestamp> <text> (insert a message at specific time)<br>"
                }

                ws.send(JSON.stringify({
                    sender_username: "system",
                    text: helpText,
                    timestamp: Date.now()
                }))
                return
            }

            ws.send(JSON.stringify({
                sender: "system",
                text: `unknown command: ${command}`,
                timestamp: Date.now()
            }))
            return
        }
  
        const timestamp = Date.now()
        const msgId = this.generateMsgId(timestamp)

        const messageObj: Message = {
            msg_id: msgId,
            sender_username: userData.username,
            sender_uid: userData.uid,
            channel: userData.roomName,
            timestamp: timestamp,
            text: data
        }
  
        const messageString = JSON.stringify(messageObj)

        await this.saveMessage(messageObj)
        this.broadcast(messageString)

        // bridge logic: forward to minecraft server via http bridge
        if (userData.roomName === "minecraft" && userData.username !== "console" && this.env.BRIDGE_URL) {
            let nameColor: string;
            switch (userData.username) {
                case "EnderDragon":
                    nameColor = "dark_purple";
                    break;
                case "Cloudrayyy":
                    nameColor = "green";
                    break;
                default:
                    nameColor = "aqua";
            }
            // escape backslashes and double quotes
            const safeText = data.replace(/\\/g, '\\\\').replace(/"/g, '\\"')

            const tellraw = `/tellraw @a [{"text": "<", "color": "white"}, {"text": "${userData.username}", "color": "${nameColor}"}, {"text": "> ", "color": "white"}, {"text": "${safeText}", "color": "white"}]`

            // fire bridge fetch independently - DO stays alive via active WebSocket connections
            // only logIncident uses waitUntil (completes instantly), keeping broadcast unblocked
            fetch(this.env.BRIDGE_URL, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${this.env.BRIDGE_TOKEN}`
                },
                body: JSON.stringify({ command: tellraw }),
                signal: AbortSignal.timeout(5000)
            }).then(async res => {
                if (res.ok) {
                    messageObj.is_bridged = true
                    await this.saveMessage(messageObj)
                    this.broadcast(JSON.stringify({
                        type: "bridge_status",
                        status: "success",
                        msg_id: msgId
                    }))
                }
            }).catch(err => {
                const isTimeout = (err as Error).name === "TimeoutError"
                const type = isTimeout ? "bridge_timeout" : "bridge_error"
                console.error("Bridge Error:", (err as Error).message)
                this.ctx.waitUntil(this.logIncident(type, {
                    room: userData.roomName,
                    username: userData.username,
                    uid: userData.uid,
                    msg_id: msgId,
                    error: (err as Error).message
                }))
            })
        }
    }

    async webSocketClose(ws: any, code: number, reason: string, wasClean: boolean) {
        if (code !== 1000) {
            const userData = ws.deserializeAttachment()
            this.ctx.waitUntil(this.logIncident("ws_close_abnormal", {
                room: userData?.roomName,
                username: userData?.username,
                uid: userData?.uid,
                code,
                reason,
                wasClean
            }))
        }
    }

    async webSocketError(ws: any, error: any) {
        const userData = ws.deserializeAttachment()
        this.ctx.waitUntil(this.logIncident("ws_error", {
            room: userData?.roomName,
            username: userData?.username,
            uid: userData?.uid,
            error: error?.message ?? String(error)
        }))
    }

    generateMsgId(timestamp = Date.now()) {
        const randomHex = Math.floor(Math.random() * 0xFFFFF).toString(16).padStart(5, '0')
        return `msg-${timestamp}-${randomHex}`
    }

    // write incident record to R2
    async logIncident(type: string, data: Record<string, any>) {
        if (!this.env.INCIDENT_LOG) return
        try {
            const now = Date.now()
            const d = new Date(now)
            const y = d.getUTCFullYear()
            const m = String(d.getUTCMonth() + 1).padStart(2, '0')
            const day = String(d.getUTCDate()).padStart(2, '0')
            const key = `incidents/${y}/${m}/${day}/${now}-${type}.json`
            const body = JSON.stringify({ type, occurred_at: now, ...data })
            await this.env.INCIDENT_LOG.put(key, body, {
                httpMetadata: { contentType: "application/json" }
            })
        } catch (e) {
            console.error("logIncident failed:", (e as Error).message)
        }
    }

    async saveMessage(messageObj: any) {
        await this.state.storage.put(messageObj.msg_id, messageObj)
    }

    async getHistory(cursor: any) {
        const options: any = {
            prefix: "msg-",
            limit: 20,
            reverse: true 
        }

        if (cursor) {
            options.end = cursor
        }

        const list: any = await this.state.storage.list(options)
        const messages = Array.from(list.values())
        
        messages.reverse()

        return new Response(JSON.stringify({ success: true, messages }), {
            headers: { "Content-Type": "application/json" }
        })
    }

    async exportHistory(limitParam: any) {
        let limit = Infinity
        if (limitParam && limitParam !== "all") {
            limit = parseInt(limitParam, 10)
            if (isNaN(limit) || limit <= 0) {
                 return new Response("Invalid limit", { status: 400 })
            }
        }
        
        const allMessages = []
        let cursor = null
        let hasMore = true

        while (hasMore) {
            const options: any = {
                prefix: "msg-",
                limit: 1000, 
                reverse: true 
            }
            
            if (limit !== Infinity) {
                const remaining = limit - allMessages.length
                if (remaining <= 0) break
                if (remaining < 1000) options.limit = remaining
            }

            if (cursor) {
                options.end = cursor
            }

            const list: any = await this.state.storage.list(options)
            const batch = Array.from(list.values())
            
            if (batch.length === 0) {
                hasMore = false
            } else {
                allMessages.push(...batch)
                cursor = Array.from(list.keys()).pop()
                
                if (batch.length < options.limit) {
                    hasMore = false
                }
            }
        }

        allMessages.reverse()

        return new Response(JSON.stringify({ success: true, messages: allMessages }), {
            headers: { "Content-Type": "application/json" }
        })
    }

    async pushRecentHistory(socket: any) {
        const list: any = await this.state.storage.list({
            prefix: "msg-",
            limit: 50,
            reverse: true 
        })
        const messages = Array.from(list.values()).reverse()

        for (const msg of messages) {
            const compatibleMsg = {
                ...(msg as any),
                sender: (msg as any).sender_username 
            }
            socket.send(JSON.stringify(compatibleMsg))
        }
    }

    broadcast(message: string) {
        this.state.getWebSockets().forEach((session: any) => {
            try {
                session.send(message)
            } catch (err) {
                // connection errors handled implicitly
            }
        })
    }
}
