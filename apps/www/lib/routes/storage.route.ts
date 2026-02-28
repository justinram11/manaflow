import { getUserFromRequest } from "@/lib/utils/auth";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

export const storageRouter = new OpenAPIHono();

const ErrorResponse = z
  .object({
    code: z.number(),
    message: z.string(),
  })
  .openapi("StorageErrorResponse");

function getStoragePath(): string {
  return process.env.CMUX_STORAGE_PATH || path.join(os.homedir(), ".cmux", "storage");
}

const MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".json": "application/json",
  ".txt": "text/plain",
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
};

// POST /storage/upload - Upload file to local storage
storageRouter.openapi(
  createRoute({
    method: "post",
    path: "/storage/upload",
    tags: ["Storage"],
    summary: "Upload file to local storage",
    request: {
      body: {
        content: {
          "multipart/form-data": {
            schema: z.object({
              file: z.string().openapi({ type: "string", format: "binary" }),
            }),
          },
        },
        required: true,
      },
    },
    responses: {
      201: {
        description: "File uploaded",
        content: {
          "application/json": {
            schema: z.object({
              id: z.string(),
              fileName: z.string(),
              mimeType: z.string(),
              size: z.number(),
            }),
          },
        },
      },
      400: {
        description: "No file provided",
        content: { "application/json": { schema: ErrorResponse } },
      },
      401: {
        description: "Unauthorized",
        content: { "application/json": { schema: ErrorResponse } },
      },
    },
  }),
  async (c) => {
    const user = await getUserFromRequest(c.req.raw);
    if (!user) return c.json({ code: 401, message: "Unauthorized" }, 401);

    const formData = await c.req.raw.formData();
    const file = formData.get("file");

    if (!file || !(file instanceof File)) {
      return c.json({ code: 400, message: "No file provided" }, 400);
    }

    const id = crypto.randomUUID();
    const storagePath = getStoragePath();
    const fileDir = path.join(storagePath, id);
    fs.mkdirSync(fileDir, { recursive: true });

    const fileName = file.name || "upload";
    const filePath = path.join(fileDir, fileName);
    const buffer = await file.arrayBuffer();
    fs.writeFileSync(filePath, Buffer.from(buffer));

    const ext = path.extname(fileName).toLowerCase();
    const mimeType = MIME_TYPES[ext] || "application/octet-stream";

    return c.json(
      {
        id,
        fileName,
        mimeType,
        size: buffer.byteLength,
      },
      201,
    );
  },
);

// GET /storage/:id - Serve file by ID
storageRouter.openapi(
  createRoute({
    method: "get",
    path: "/storage/{id}",
    tags: ["Storage"],
    summary: "Serve file by ID",
    request: {
      params: z.object({ id: z.string() }),
    },
    responses: {
      200: {
        description: "File content",
      },
      404: {
        description: "File not found",
        content: { "application/json": { schema: ErrorResponse } },
      },
    },
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    const storagePath = getStoragePath();
    const fileDir = path.join(storagePath, id);

    if (!fs.existsSync(fileDir)) {
      return c.json({ code: 404, message: "File not found" }, 404);
    }

    const files = fs.readdirSync(fileDir);
    if (files.length === 0) {
      return c.json({ code: 404, message: "File not found" }, 404);
    }

    const fileName = files[0];
    const filePath = path.join(fileDir, fileName);
    const ext = path.extname(fileName).toLowerCase();
    const mimeType = MIME_TYPES[ext] || "application/octet-stream";

    const fileBuffer = fs.readFileSync(filePath);

    return new Response(fileBuffer, {
      status: 200,
      headers: {
        "Content-Type": mimeType,
        "Content-Disposition": `inline; filename="${fileName}"`,
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  },
);
