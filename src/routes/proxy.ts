import { Hono } from 'hono'
import { Bindings, Variables } from '../types'
import { authMiddleware } from '../middleware/auth'

export interface ProxyNode {
    id: string
    name: string
    type: 'static' | 'dynamic'
    server_ip: string
    server_port: number
    server_name: string
    public_key: string
    short_id: string
    is_active: number
}

interface ProxyUser {
    uid: string
    xray_uuid: string
    sub_token: string
    static_quota: number
    static_used: number
    static_is_blocked: number
    dynamic_used: number
    dynamic_is_blocked: number
    token_created_at: number
    updated_at: number
}

interface UsageReport {
    email: string
    uplink_delta: number
    downlink_delta: number
}

function generateToken(): string {
    const arr = new Uint8Array(24)
    crypto.getRandomValues(arr)
    return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('')
}

function getCurrentYearMonth(): { year: number; month: number } {
    const now = new Date() // UTC
    return { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1 }
}

async function getDynamicQuota(db: D1Database, uid: string): Promise<number> {
    const BASE_QUOTA = 1073741824 // 1GB
    const CHECKIN_BONUS = 134217728 // 128MB
    const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000

    const row = await db.prepare(
        'SELECT COUNT(*) as c FROM proxy_checkins WHERE uid = ? AND created_at >= ?'
    ).bind(uid, thirtyDaysAgo).first<{ c: number }>()

    return BASE_QUOTA + (row?.c || 0) * CHECKIN_BONUS
}

async function archiveAndReset(
    db: D1Database,
    uid: string,
    staticUsed: number,
    staticQuota: number,
    dynamicUsed: number,
    dynamicQuota: number,
    year: number,
    month: number
): Promise<void> {
    const now = Date.now()
    await db.batch([
        db.prepare(
            `INSERT OR REPLACE INTO proxy_usage_history
             (uid, year, month, static_used, static_quota, dynamic_used, dynamic_quota, archived_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(uid, year, month, staticUsed, staticQuota, dynamicUsed, dynamicQuota, now),
        db.prepare(
            `UPDATE proxy_users
             SET static_used = 0, static_is_blocked = 0, dynamic_used = 0, dynamic_is_blocked = 0, updated_at = ?
             WHERE uid = ?`
        ).bind(now, uid),
    ])
}

const proxy = new Hono<{ Bindings: Bindings; Variables: Variables }>()

// ─── Public subscription endpoints ───────────────────────────────────────────

proxy.get('/sub/:token/mihomo', async (c) => {
    const token = c.req.param('token')
    const row = await c.env.DB.prepare(
        `SELECT pu.uid, pu.xray_uuid, pu.static_used, pu.static_quota, u.username
         FROM proxy_users pu
         JOIN users u ON u.uid = pu.uid
         WHERE pu.sub_token = ?`
    ).bind(token).first<{ uid: string; xray_uuid: string; static_used: number; static_quota: number; username: string }>()

    if (!row) return c.text('Not Found', 404)

    const nodes = await c.env.DB.prepare('SELECT * FROM proxy_nodes WHERE is_active = 1').all<ProxyNode>()
    const activeNodes = nodes.results

    if (activeNodes.length === 0) return c.text('No active nodes', 404)

    let proxiesYaml = 'proxies:\n'
    const nodeNames: string[] = []

    for (const node of activeNodes) {
        nodeNames.push(node.name)
        proxiesYaml += `  - name: "${node.name}"
    type: vless
    server: ${node.server_ip}
    port: ${node.server_port}
    uuid: ${row.xray_uuid}
    udp: true
    tls: true
    flow: xtls-rprx-vision
    servername: ${node.server_name}
    network: tcp
    reality-opts:
      public-key: ${node.public_key}
      short-id: ${node.short_id}
    client-fingerprint: chrome\n`
    }

    const nodeNamesList = nodeNames.map(n => `      - "${n}"`).join('\n')

    const yaml = `${proxiesYaml}proxy-groups:
  - name: Proxy
    type: select
    proxies:
${nodeNamesList}
      - DIRECT
  - name: Claude
    type: select
    proxies:
      - Proxy
${nodeNamesList}
      - DIRECT
  - name: AdBlock
    type: select
    proxies:
      - REJECT
      - DIRECT
rules:
  # === Claude ===
  - DOMAIN-SUFFIX,anthropic.com,Claude
  - DOMAIN-SUFFIX,claude.ai,Claude
  - DOMAIN-SUFFIX,claude.com,Claude
  - DOMAIN-SUFFIX,clau.de,Claude
  - DOMAIN-SUFFIX,claudemcpclient.com,Claude
  - DOMAIN-SUFFIX,claudemcpcontent.com,Claude
  - DOMAIN-SUFFIX,claudeusercontent.com,Claude
  - DOMAIN,servd-anthropic-website.b-cdn.net,Claude
  - DOMAIN,anthropic.com.cdn.cloudflare.net,Claude
  - DOMAIN,anthropic.auth0.com,Claude
  - DOMAIN,anthropic-com.ghost.io,Claude
  - DOMAIN-SUFFIX,sentry.io,Claude
  - DOMAIN-SUFFIX,statsigapi.net,Claude
  - DOMAIN,browser-intake-us5-datadoghq.com,Claude
  - DOMAIN-KEYWORD,datadog,Claude
  - DOMAIN-KEYWORD,sift,Claude
  - DOMAIN-SUFFIX,intercom.io,Claude
  - DOMAIN-SUFFIX,intercomcdn.com,Claude
  - DOMAIN,cdn.usefathom.com,Claude
  - GEOSITE,category-ntp,Claude
  - IP-CIDR,160.79.104.0/21,Claude,no-resolve
  - IP-CIDR6,2607:6bc0::/32,Claude,no-resolve
  - IP-ASN,399358,Claude,no-resolve
  # === Others ===
  - GEOIP,private,DIRECT,no-resolve
  - GEOSITE,category-ads-all,AdBlock
  - GEOSITE,gfw,Proxy
  - GEOSITE,geolocation-!cn,Proxy
  - GEOSITE,cn,DIRECT
  - GEOIP,CN,DIRECT
  - MATCH,Proxy
dns:
  enable: true
  listen: "0.0.0.0:1053"
  prefer-h3: false
  use-hosts: true
  use-system-hosts: true
  respect-rules: false
  ipv6: false
  default-nameserver:
    - "223.5.5.5"
  enhanced-mode: "fake-ip"
  fake-ip-range: "198.18.0.1/16"
  fake-ip-filter:
    - "*.lan"
    - "localhost.ptlogin2.qq.com"
  nameserver-policy:
    www.baidu.com: "114.114.114.114"
    +.internal.crop.com: "10.0.0.1"
    geosite:cn: "https://doh.pub/dns-query"
  nameserver:
    - "https://dns.google/dns-query#Proxy"
    - "https://dns.cloudflare.com/dns-query#Proxy"
  fallback:
    - "tls://8.8.4.4#Proxy"
    - "tls://1.1.1.1#Proxy"
  proxy-server-nameserver:
    - "https://doh.pub/dns-query"
  fallback-filter:
    geoip: true
    geoip-code: "CN"
    geosite: []
    ipcidr:
      - "240.0.0.0/4"
    domain:
      - "+.google.com"
      - "+.facebook.com"
      - "+.youtube.com"`

    return c.text(yaml, 200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Disposition': 'attachment; filename="Salmon Network Communications.yaml"',
        'Subscription-Userinfo': `upload=0; download=${row.static_used}; total=${row.static_quota}; expire=0`
    })
})

proxy.get('/sub/:token/shadowrocket', async (c) => {
    const token = c.req.param('token')
    const row = await c.env.DB.prepare(
        `SELECT pu.uid, pu.xray_uuid, pu.static_used, pu.static_quota
         FROM proxy_users pu
         WHERE pu.sub_token = ?`
    ).bind(token).first<{ uid: string; xray_uuid: string; static_used: number; static_quota: number }>()

    if (!row) return c.text('Not Found', 404)

    const nodes = await c.env.DB.prepare('SELECT * FROM proxy_nodes WHERE is_active = 1').all<ProxyNode>()
    
    const uris = nodes.results.map(n => 
        `vless://${row.xray_uuid}@${n.server_ip}:${n.server_port}?security=reality&encryption=none&pbk=${n.public_key}&headerType=none&fp=chrome&type=tcp&flow=xtls-rprx-vision&sni=${n.server_name}&sid=${n.short_id}#${encodeURIComponent(n.name)}`
    ).join('\n')

    const base64Str = btoa(uris)

    return c.text(base64Str, 200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Subscription-Userinfo': `upload=0; download=${row.static_used}; total=${row.static_quota}; expire=0`
    })
})

// ─── Authenticated user API ───────────────────────────────────────────────────

proxy.use('/api/user/proxy*', authMiddleware)

proxy.get('/api/user/proxy', async (c) => {
    const me = c.get('user')!

    const myRow = await c.env.DB.prepare(
        `SELECT pu.xray_uuid, pu.sub_token, pu.static_quota, pu.static_used,
                pu.static_is_blocked, pu.dynamic_used, pu.dynamic_is_blocked, pu.token_created_at, pu.updated_at
         FROM proxy_users pu WHERE pu.uid = ?`
    ).bind(me.uid).first<ProxyUser>()

    let dynamicQuota = 1073741824
    let hasCheckedInToday = false
    
    if (myRow) {
        dynamicQuota = await getDynamicQuota(c.env.DB, me.uid)
        const todayStart = new Date()
        todayStart.setUTCHours(0, 0, 0, 0)
        const checkinRow = await c.env.DB.prepare(
            'SELECT 1 FROM proxy_checkins WHERE uid = ? AND created_at >= ? LIMIT 1'
        ).bind(me.uid, todayStart.getTime()).first()
        hasCheckedInToday = !!checkinRow
    }

    const allRows = await c.env.DB.prepare(
        `SELECT u.username, pu.uid, pu.static_quota, pu.static_used, pu.static_is_blocked,
                pu.dynamic_used, pu.dynamic_is_blocked
         FROM proxy_users pu
         JOIN users u ON u.uid = pu.uid
         ORDER BY pu.static_used DESC`
    ).all<{ username: string; uid: string; static_quota: number; static_used: number; static_is_blocked: number; dynamic_used: number; dynamic_is_blocked: number }>()

    const allUsersWithDynamicQuota = await Promise.all(allRows.results.map(async (u) => {
        const dq = await getDynamicQuota(c.env.DB, u.uid)
        return {
            username: u.username,
            static_quota: u.static_quota,
            static_used: u.static_used,
            static_is_blocked: u.static_is_blocked,
            dynamic_quota: dq,
            dynamic_used: u.dynamic_used,
            dynamic_is_blocked: u.dynamic_is_blocked
        }
    }))

    const history = myRow
        ? await c.env.DB.prepare(
            `SELECT year, month, static_used, static_quota, dynamic_used, dynamic_quota
             FROM proxy_usage_history
             WHERE uid = ? ORDER BY year DESC, month DESC LIMIT 12`
          ).bind(me.uid).all<{
              year: number; month: number;
              static_used: number; static_quota: number;
              dynamic_used: number; dynamic_quota: number;
          }>()
        : { results: [] }

    return c.json({
        success: true,
        activated: !!myRow,
        my_proxy: myRow
            ? {
                xray_uuid: myRow.xray_uuid,
                sub_token: myRow.sub_token,
                static_quota: myRow.static_quota,
                static_used: myRow.static_used,
                static_is_blocked: myRow.static_is_blocked === 1,
                dynamic_quota: dynamicQuota,
                dynamic_used: myRow.dynamic_used,
                dynamic_is_blocked: myRow.dynamic_is_blocked === 1,
                has_checked_in_today: hasCheckedInToday,
                token_created_at: myRow.token_created_at,
            }
            : null,
        history: history.results,
        all_users: allUsersWithDynamicQuota,
    })
})

proxy.post('/api/user/proxy/activate', authMiddleware, async (c) => {
    const me = c.get('user')!
    if (me.role === 'admin') return c.json({ success: false, message: 'admin cannot activate proxy' }, 403)

    const existing = await c.env.DB.prepare('SELECT uid FROM proxy_users WHERE uid = ?').bind(me.uid).first()
    if (existing) return c.json({ success: false, message: 'already activated' }, 409)

    const xrayUuid = crypto.randomUUID()
    const subToken = generateToken()
    const now = Date.now()

    await c.env.DB.prepare(
        `INSERT INTO proxy_users
         (uid, xray_uuid, sub_token, static_quota, static_used, static_is_blocked, dynamic_used, dynamic_is_blocked,
          token_created_at, updated_at)
         VALUES (?, ?, ?, 42949672960, 0, 0, 0, 0, ?, ?)`
    ).bind(me.uid, xrayUuid, subToken, now, now).run()

    return c.json({ success: true, xray_uuid: xrayUuid, sub_token: subToken })
})

proxy.post('/api/user/proxy/reset-token', authMiddleware, async (c) => {
    const me = c.get('user')!
    const existing = await c.env.DB.prepare('SELECT uid FROM proxy_users WHERE uid = ?').bind(me.uid).first()
    if (!existing) return c.json({ success: false, message: 'proxy not activated' }, 404)

    const newToken = generateToken()
    await c.env.DB.prepare('UPDATE proxy_users SET sub_token = ?, updated_at = ? WHERE uid = ?').bind(newToken, Date.now(), me.uid).run()

    return c.json({ success: true, sub_token: newToken })
})

proxy.post('/api/user/proxy/checkin', authMiddleware, async (c) => {
    const me = c.get('user')!
    const existing = await c.env.DB.prepare('SELECT uid FROM proxy_users WHERE uid = ?').bind(me.uid).first()
    if (!existing) return c.json({ success: false, message: 'proxy not activated' }, 404)

    const todayStart = new Date()
    todayStart.setUTCHours(0, 0, 0, 0)
    
    const checkinRow = await c.env.DB.prepare(
        'SELECT 1 FROM proxy_checkins WHERE uid = ? AND created_at >= ? LIMIT 1'
    ).bind(me.uid, todayStart.getTime()).first()
    
    if (checkinRow) {
        return c.json({ success: false, message: 'already checked in today' }, 400)
    }

    await c.env.DB.prepare('INSERT INTO proxy_checkins (uid, created_at) VALUES (?, ?)').bind(me.uid, Date.now()).run()
    const newDynamicQuota = await getDynamicQuota(c.env.DB, me.uid)

    return c.json({ success: true, message: 'checked in', dynamic_quota: newDynamicQuota })
})


// ─── Admin API ────────────────────────────────────────────────────────────────

proxy.use('/api/admin/proxy*', authMiddleware)

proxy.get('/api/admin/proxy', async (c) => {
    const me = c.get('user')!
    if (me.role !== 'admin') return c.json({ success: false }, 403)

    const rows = await c.env.DB.prepare(
        `SELECT u.uid, u.username, u.role,
                pu.xray_uuid, pu.sub_token, pu.static_quota,
                pu.static_used, pu.static_is_blocked, pu.dynamic_used, pu.dynamic_is_blocked, pu.token_created_at
         FROM users u
         LEFT JOIN proxy_users pu ON pu.uid = u.uid
         WHERE u.role != 'admin'
         ORDER BY u.username`
    ).all()
    
    const usersWithDynamicQuota = await Promise.all(rows.results.map(async (u: any) => {
        if (u.uid && u.xray_uuid) {
            u.dynamic_quota = await getDynamicQuota(c.env.DB, u.uid)
        }
        return u
    }))

    return c.json({ success: true, users: usersWithDynamicQuota })
})

proxy.put('/api/admin/proxy/:uid', authMiddleware, async (c) => {
    const me = c.get('user')!
    if (me.role !== 'admin') return c.json({ success: false }, 403)

    const targetUid = c.req.param('uid')
    const body = await c.req.json<{
        static_quota?: number
        static_is_blocked?: boolean
        dynamic_is_blocked?: boolean
    }>()

    const existing = await c.env.DB.prepare('SELECT uid FROM proxy_users WHERE uid = ?').bind(targetUid).first()
    if (!existing) return c.json({ success: false, message: 'user not activated' }, 404)

    const updates: string[] = []
    const values: (number | string)[] = []

    if (typeof body.static_quota === 'number') {
        updates.push('static_quota = ?')
        values.push(body.static_quota)
    }
    if (typeof body.static_is_blocked === 'boolean') {
        updates.push('static_is_blocked = ?')
        values.push(body.static_is_blocked ? 1 : 0)
    }
    if (typeof body.dynamic_is_blocked === 'boolean') {
        updates.push('dynamic_is_blocked = ?')
        values.push(body.dynamic_is_blocked ? 1 : 0)
    }

    if (updates.length === 0) return c.json({ success: false, message: 'nothing to update' }, 400)

    updates.push('updated_at = ?')
    values.push(Date.now(), targetUid)

    await c.env.DB.prepare(`UPDATE proxy_users SET ${updates.join(', ')} WHERE uid = ?`).bind(...values).run()
    return c.json({ success: true })
})

// ─── Internal API (salmonop only) ─────────────────────────────────────────────

function requireInternalToken(env: Bindings, req: Request): boolean {
    const auth = req.headers.get('Authorization') ?? ''
    const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : ''
    const expected = (env.PROXY_INTERNAL_TOKEN || '').trim()
    return token === expected && expected.length > 0
}

proxy.get('/internal/proxy-config/:nodeId', async (c) => {
    if (!requireInternalToken(c.env, c.req.raw)) return c.json({ success: false }, 401)
    const nodeId = c.req.param('nodeId')

    const node = await c.env.DB.prepare('SELECT type FROM proxy_nodes WHERE id = ?').bind(nodeId).first<{ type: string }>()
    if (!node) return c.json({ success: false, message: 'unknown node' }, 404)

    const blockedCol = node.type === 'static' ? 'static_is_blocked' : 'dynamic_is_blocked'
    
    const rows = await c.env.DB.prepare(
        `SELECT pu.uid, pu.xray_uuid, pu.${blockedCol} as is_blocked, u.username
         FROM proxy_users pu
         JOIN users u ON u.uid = pu.uid`
    ).all<{ uid: string; xray_uuid: string; is_blocked: number; username: string }>()

    const users = rows.results.map(r => ({
        uid: r.uid,
        xray_uuid: r.xray_uuid,
        email: `${r.username}@caffeine`,
        is_blocked: r.is_blocked === 1,
    }))

    return c.json({ success: true, users })
})

proxy.post('/internal/usage/:nodeId', async (c) => {
    if (!requireInternalToken(c.env, c.req.raw)) return c.json({ success: false }, 401)
    const nodeId = c.req.param('nodeId')

    const node = await c.env.DB.prepare('SELECT type FROM proxy_nodes WHERE id = ?').bind(nodeId).first<{ type: string }>()
    if (!node) return c.json({ success: false, message: 'unknown node' }, 404)

    const body = await c.req.json<{ reports: UsageReport[] }>()
    if (!body.reports || !Array.isArray(body.reports)) {
        return c.json({ success: false, message: 'invalid payload' }, 400)
    }

    const { year, month } = getCurrentYearMonth()
    const now = Date.now()
    const newlyBlocked: string[] = []

    for (const report of body.reports) {
        const delta = report.uplink_delta + report.downlink_delta
        if (delta <= 0) continue

        const username = report.email.replace('@caffeine', '')
        const row = await c.env.DB.prepare(
            `SELECT pu.uid, pu.static_used, pu.static_quota, pu.static_is_blocked,
                    pu.dynamic_used, pu.dynamic_is_blocked, pu.updated_at
             FROM proxy_users pu
             JOIN users u ON u.uid = pu.uid
             WHERE u.username = ?`
        ).bind(username).first<ProxyUser & { username: string }>()

        if (!row) continue

        const lastUpdate = new Date(row.updated_at)
        const lastYear = lastUpdate.getUTCFullYear()
        const lastMonth = lastUpdate.getUTCMonth() + 1
        
        let localStaticUsed = row.static_used
        let localDynamicUsed = row.dynamic_used
        let localStaticBlocked = row.static_is_blocked
        let localDynamicBlocked = row.dynamic_is_blocked

        if (lastYear !== year || lastMonth !== month) {
            const dynamicQuota = await getDynamicQuota(c.env.DB, row.uid)
            await archiveAndReset(
                c.env.DB, row.uid,
                row.static_used, row.static_quota,
                row.dynamic_used, dynamicQuota,
                lastYear, lastMonth
            )
            localStaticUsed = 0
            localDynamicUsed = 0
            localStaticBlocked = 0
            localDynamicBlocked = 0
        }

        let isBlockedNow = 0
        
        if (node.type === 'static') {
            localStaticUsed += delta
            isBlockedNow = localStaticUsed >= row.static_quota ? 1 : 0
            await c.env.DB.prepare(
                'UPDATE proxy_users SET static_used = ?, static_is_blocked = ?, updated_at = ? WHERE uid = ?'
            ).bind(localStaticUsed, isBlockedNow, now, row.uid).run()
            
            if (isBlockedNow && !localStaticBlocked) newlyBlocked.push(report.email)
        } else {
            localDynamicUsed += delta
            const dynamicQuota = await getDynamicQuota(c.env.DB, row.uid)
            isBlockedNow = localDynamicUsed >= dynamicQuota ? 1 : 0
            await c.env.DB.prepare(
                'UPDATE proxy_users SET dynamic_used = ?, dynamic_is_blocked = ?, updated_at = ? WHERE uid = ?'
            ).bind(localDynamicUsed, isBlockedNow, now, row.uid).run()
            
            if (isBlockedNow && !localDynamicBlocked) newlyBlocked.push(report.email)
        }
    }

    const blockedCol = node.type === 'static' ? 'static_is_blocked' : 'dynamic_is_blocked'
    const blocked = await c.env.DB.prepare(
        `SELECT u.username FROM proxy_users pu
         JOIN users u ON u.uid = pu.uid WHERE pu.${blockedCol} = 1`
    ).all<{ username: string }>()

    return c.json({
        success: true,
        newly_blocked: newlyBlocked,
        blocked_emails: blocked.results.map(r => `${r.username}@caffeine`),
    })
})

export default proxy
