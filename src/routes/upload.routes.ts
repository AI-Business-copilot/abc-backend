import { Router, Request, Response } from "express";

const uploadRouter = Router();

uploadRouter.post("/", async (req: Request, res: Response) => {
  try {
    const { base64, filename, contentType } = req.body;
    if (!base64) {
      return res.status(400).json({ error: "Thiếu dữ liệu ảnh (base64)." });
    }

    const supabaseUrl = process.env.SUPABASE_URL || "https://vhivkicmqwjiypvbssbv.supabase.co";
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const bucket = process.env.SUPABASE_BUCKET ? process.env.SUPABASE_BUCKET.replace(/"/g, "") : "SEP";

    if (!serviceKey) {
      return res.status(500).json({ error: "Chưa cấu hình SUPABASE_SERVICE_ROLE_KEY trên server." });
    }

    // Tách header data:image/...;base64,
    const matches = String(base64).match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
    const mime = contentType || (matches ? matches[1] : "image/jpeg");
    const rawData = matches ? matches[2] : base64;
    const buffer = Buffer.from(rawData, "base64");

    const ext = mime.split("/")[1]?.replace("jpeg", "jpg") || "jpg";
    const cleanName = (filename || "image").replace(/[^a-zA-Z0-9.-]/g, "_");
    const filePath = `products/${Date.now()}_${Math.random().toString(36).substring(2, 8)}_${cleanName}.${ext}`;

    const uploadRes = await fetch(`${supabaseUrl}/storage/v1/object/${bucket}/${filePath}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${serviceKey}`,
        apiKey: serviceKey,
        "Content-Type": mime,
      },
      body: buffer,
    });

    if (!uploadRes.ok) {
      const errText = await uploadRes.text();
      return res.status(uploadRes.status).json({
        error: `Không thể tải ảnh lên Supabase bucket ${bucket}: ${errText}`,
      });
    }

    const publicUrl = `${supabaseUrl}/storage/v1/object/public/${bucket}/${filePath}`;
    return res.json({ url: publicUrl, path: filePath });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || "Lỗi upload ảnh." });
  }
});

export default uploadRouter;

