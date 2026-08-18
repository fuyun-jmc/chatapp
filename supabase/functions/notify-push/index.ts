// Supabase Edge Function —— 接收前端调用，向目标用户推送 Web Push 系统通知
// 部署：supabase functions deploy notify-push
// 环境变量（Supabase 控制台 → Edge Functions → notify-push → 添加）：
//   VAPID_PRIVATE_KEY  = 4TdqqVYAPAEBdprBorE2myuFGifRrnFidEuU-AJLfDY
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import webpush from "https://esm.sh/web-push@3.6.7";

const VAPID_PUBLIC_KEY =
  "BKQZOGfokElG3T0vL2jkelS5x_EucYbInilpJqJnTDMu8H5iHakZnYe1cjWRJiTxzZytMLJvwghmtYPCPbzJ-3o";
const VAPID_SUBJECT = "mailto:admin@yunliao.app";

webpush.setVapidDetails(
  VAPID_SUBJECT,
  VAPID_PUBLIC_KEY,
  Deno.env.get("VAPID_PRIVATE_KEY") || ""
);

const supabase = createClient(
  Deno.env.get("SUPABASE_URL") ?? "",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
);

function json(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers":
        "authorization, x-client-info, apikey, content-type",
    },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return json({ ok: true });
  try {
    const body = await req.json().catch(() => ({}));
    const receiver_ids: string[] = (body.receiver_ids || []).filter(Boolean);
    const group_id: string | null = body.group_id || null;
    const sender_id: string = body.sender_id || "";
    const sender_name: string = body.sender_name || "有人";
    const preview: string = (body.preview || "").toString().slice(0, 200);
    const url: string = body.url || "./";

    // 解析最终接收者（前端传 receiver_ids；群聊也可只传 group_id 由后端查成员）
    let targetIds: string[] = receiver_ids.slice();
    if (!targetIds.length && group_id) {
      const { data: members } = await supabase
        .from("group_members")
        .select("user_id")
        .eq("group_id", group_id);
      targetIds = (members || []).map((m: any) => m.user_id);
    }
    targetIds = Array.from(new Set(targetIds)).filter(
      (id) => id && id !== sender_id
    );
    if (!targetIds.length) return json({ ok: true, sent: 0, reason: "no_targets" });

    const { data: subs, error } = await supabase
      .from("push_subscriptions")
      .select("endpoint, p256dh, auth")
      .in("user_id", targetIds);
    if (error) throw error;
    if (!subs || !subs.length) return json({ ok: true, sent: 0, reason: "no_subs" });

    const payload = JSON.stringify({
      title: sender_name,
      body: preview,
      url,
      tag: group_id ? "group:" + group_id : "peer:" + sender_id,
      ts: Date.now(),
      sender: sender_id,
    });

    let sent = 0;
    const failures: string[] = [];
    for (const sub of subs) {
      try {
        await webpush.sendNotification(
          {
            endpoint: sub.endpoint,
            keys: { p256dh: sub.p256dh, auth: sub.auth },
          },
          payload
        );
        sent++;
      } catch (e: any) {
        const status = e && e.statusCode;
        if (status === 410 || status === 404) {
          // 订阅已失效，清理脏数据
          await supabase
            .from("push_subscriptions")
            .delete()
            .eq("endpoint", sub.endpoint);
        } else {
          failures.push(String((e && e.message) || e));
        }
      }
    }
    return json({ ok: true, sent, targets: targetIds.length, failures });
  } catch (err: any) {
    return json({ ok: false, error: String((err && err.message) || err) }, 500);
  }
});
