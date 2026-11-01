import { randomUUID } from "node:crypto";

import { HttpError } from "../../../shared/http/http-error";
import { detectImageType } from "../../../shared/http/upload.middleware";
import { prisma } from "../../../shared/infrastructure/database/prisma.client";
import {
  createSignedUrls,
  deleteObjects,
  uploadObject,
} from "../../../shared/infrastructure/storage/supabase-storage";
import { assertStaff, assertUuid, lockScrapOrder, type ScrapActor } from "./scrap-access";

export const MAX_IMAGES_PER_ORDER = 10;

const IMAGE_SELECT = {
  id: true,
  scrapOrderId: true,
  storagePath: true,
  mimeType: true,
  sizeBytes: true,
  note: true,
  uploadedBy: true,
  createdAt: true,
  updatedAt: true,
  uploadedByUser: { select: { id: true, fullName: true } },
} as const;

type ImageRow = {
  id: string;
  scrapOrderId: string;
  storagePath: string;
  mimeType: string;
  sizeBytes: number;
  note: string | null;
  uploadedBy: string;
  createdAt: Date;
  updatedAt: Date;
  uploadedByUser: { id: string; fullName: string };
};

export type ScrapImageDto = {
  id: string;
  scrapOrderId: string;
  mimeType: string;
  sizeBytes: number;
  note: string | null;
  uploadedBy: string;
  uploadedByName: string;
  createdAt: Date;
  updatedAt: Date;
  /** Short-lived signed link (5 minutes). Null when storage could not sign it. */
  url: string | null;
};

/** Reading never fails because Storage is down: the metadata is still returned with url = null. */
async function signUrls(paths: string[]): Promise<Map<string, string>> {
  try {
    return await createSignedUrls(paths);
  } catch (error) {
    console.warn("Could not sign scrap image links.", error);
    return new Map();
  }
}

function toDto(row: ImageRow, urls: Map<string, string>): ScrapImageDto {
  return {
    id: row.id,
    scrapOrderId: row.scrapOrderId,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    note: row.note,
    uploadedBy: row.uploadedBy,
    uploadedByName: row.uploadedByUser.fullName,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    url: urls.get(row.storagePath) ?? null,
  };
}

function parseNote(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new HttpError(400, "note must be text.");
  }
  const note = value.trim();
  if (note.length > 500) {
    throw new HttpError(400, "note must be 500 characters or fewer.");
  }
  return note || null;
}

export class ScrapImageService {
  /** Non-deleted images of one order with signed links. The caller has already checked the order belongs to the business. */
  async listImagesForOrder(businessId: string, scrapOrderId: string): Promise<ScrapImageDto[]> {
    const rows = await prisma.scrapOrderImage.findMany({
      where: { businessId, scrapOrderId, deletedAt: null },
      select: IMAGE_SELECT,
      orderBy: { createdAt: "asc" },
    });
    const urls = await signUrls(rows.map((row) => row.storagePath));
    return rows.map((row) => toDto(row, urls));
  }

  async listImages(businessId: string, scrapOrderId: string): Promise<ScrapImageDto[]> {
    assertUuid(scrapOrderId, "Scrap order");
    const order = await prisma.scrapOrder.findFirst({
      where: { id: scrapOrderId, businessId },
      select: { id: true },
    });
    if (!order) {
      throw new HttpError(404, "Scrap order not found");
    }
    return this.listImagesForOrder(businessId, scrapOrderId);
  }

  async getImage(businessId: string, imageId: string): Promise<ScrapImageDto> {
    assertUuid(imageId, "Image");
    const row = await prisma.scrapOrderImage.findFirst({
      where: { id: imageId, businessId, deletedAt: null },
      select: IMAGE_SELECT,
    });
    if (!row) {
      throw new HttpError(404, "Image not found");
    }
    const urls = await signUrls([row.storagePath]);
    return toDto(row, urls);
  }

  /** Only the STAFF member who created the order can add photos, and only while it is PENDING. */
  async uploadImage(
    businessId: string,
    actor: ScrapActor,
    scrapOrderId: string,
    file: { buffer: Buffer } | undefined,
    noteInput: unknown,
  ): Promise<ScrapImageDto> {
    assertStaff(actor);
    assertUuid(scrapOrderId, "Scrap order");
    const note = parseNote(noteInput);

    if (!file || file.buffer.length === 0) {
      throw new HttpError(400, "Send the image in the 'file' field.");
    }
    const detected = detectImageType(file.buffer);
    if (!detected) {
      throw new HttpError(415, "Only JPEG, PNG or WebP images are accepted.");
    }

    // Cheap checks first so a rejected request never reaches Storage.
    const order = await prisma.scrapOrder.findFirst({
      where: { id: scrapOrderId, businessId },
      select: { createdBy: true, status: true },
    });
    if (!order) {
      throw new HttpError(404, "Scrap order not found");
    }
    if (order.createdBy !== actor.userId) {
      throw new HttpError(403, "Only the staff member who created this scrap order can add photos.");
    }
    if (order.status !== "PENDING") {
      throw new HttpError(409, `Photos cannot be added to a ${order.status} scrap order.`);
    }

    const existing = await prisma.scrapOrderImage.count({
      where: { businessId, scrapOrderId, deletedAt: null },
    });
    if (existing >= MAX_IMAGES_PER_ORDER) {
      throw new HttpError(409, `A scrap order can have at most ${MAX_IMAGES_PER_ORDER} photos.`);
    }

    const storagePath = `${businessId}/scrap-orders/${scrapOrderId}/${randomUUID()}.${detected.extension}`;
    await uploadObject(storagePath, file.buffer, detected.mimeType);

    try {
      const row = await prisma.$transaction(async (tx) => {
        // Re-check under the order lock: the order may have been approved, rejected or filled up meanwhile.
        const locked = await lockScrapOrder(tx, businessId, scrapOrderId);
        if (locked.status !== "PENDING") {
          throw new HttpError(409, `Photos cannot be added to a ${locked.status} scrap order.`);
        }
        const count = await tx.scrapOrderImage.count({
          where: { businessId, scrapOrderId, deletedAt: null },
        });
        if (count >= MAX_IMAGES_PER_ORDER) {
          throw new HttpError(409, `A scrap order can have at most ${MAX_IMAGES_PER_ORDER} photos.`);
        }
        return tx.scrapOrderImage.create({
          data: {
            businessId,
            scrapOrderId,
            storagePath,
            mimeType: detected.mimeType,
            sizeBytes: file.buffer.length,
            note,
            uploadedBy: actor.userId,
          },
          select: IMAGE_SELECT,
        });
      });

      const urls = await signUrls([row.storagePath]);
      return toDto(row, urls);
    } catch (error) {
      // The database rejected the row, so the uploaded file would be an orphan.
      await deleteObjects([storagePath]);
      throw error;
    }
  }

  /** Only the uploader can change the note, and only while the order is PENDING. The file itself cannot be replaced. */
  async updateImageNote(
    businessId: string,
    actor: ScrapActor,
    imageId: string,
    noteInput: unknown,
  ): Promise<ScrapImageDto> {
    assertStaff(actor);
    assertUuid(imageId, "Image");
    if (noteInput !== null && typeof noteInput !== "string") {
      throw new HttpError(400, "note must be text or null.");
    }
    const note = parseNote(noteInput);

    const image = await this.loadOwnImage(businessId, actor, imageId);

    await prisma.$transaction(async (tx) => {
      const locked = await lockScrapOrder(tx, businessId, image.scrapOrderId);
      if (locked.status !== "PENDING") {
        throw new HttpError(409, `Photos of a ${locked.status} scrap order cannot be changed.`);
      }
      const result = await tx.scrapOrderImage.updateMany({
        where: { id: imageId, businessId, deletedAt: null },
        data: { note, updatedAt: new Date() },
      });
      if (result.count === 0) {
        throw new HttpError(404, "Image not found");
      }
    });

    return this.getImage(businessId, imageId);
  }

  /** Soft delete: the row and the file stay for the audit trail. Only the uploader, only while PENDING. */
  async deleteImage(businessId: string, actor: ScrapActor, imageId: string): Promise<void> {
    assertStaff(actor);
    assertUuid(imageId, "Image");
    const image = await this.loadOwnImage(businessId, actor, imageId);

    await prisma.$transaction(async (tx) => {
      const locked = await lockScrapOrder(tx, businessId, image.scrapOrderId);
      if (locked.status !== "PENDING") {
        throw new HttpError(409, `Photos of a ${locked.status} scrap order cannot be deleted.`);
      }
      const now = new Date();
      const result = await tx.scrapOrderImage.updateMany({
        where: { id: imageId, businessId, deletedAt: null },
        data: { deletedAt: now, deletedBy: actor.userId, updatedAt: now },
      });
      if (result.count === 0) {
        throw new HttpError(404, "Image not found");
      }
    });
  }

  private async loadOwnImage(businessId: string, actor: ScrapActor, imageId: string) {
    const image = await prisma.scrapOrderImage.findFirst({
      where: { id: imageId, businessId, deletedAt: null },
      select: { id: true, scrapOrderId: true, uploadedBy: true },
    });
    if (!image) {
      throw new HttpError(404, "Image not found");
    }
    if (image.uploadedBy !== actor.userId) {
      throw new HttpError(403, "Only the staff member who uploaded this photo can change it.");
    }
    return image;
  }
}
