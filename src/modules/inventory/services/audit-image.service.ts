import { HttpError } from "../../../shared/http/http-error";
import { detectImageType } from "../../../shared/http/upload.middleware";
import { prisma } from "../../../shared/infrastructure/database/prisma.client";
import { createSignedUrls } from "../../../shared/infrastructure/storage/supabase-storage";
import { assertUuid } from "./scrap-access";

export const MAX_IMAGES_PER_COUNT = 10;

const IMAGE_SELECT = {
  id: true,
  countId: true,
  storagePath: true,
  mimeType: true,
  sizeBytes: true,
  uploadedBy: true,
  createdAt: true,
  updatedAt: true,
  uploadedByUser: { select: { id: true, fullName: true } },
} as const;

type ImageRow = {
  id: string;
  countId: string;
  storagePath: string;
  mimeType: string;
  sizeBytes: number;
  uploadedBy: string;
  createdAt: Date;
  updatedAt: Date;
  uploadedByUser: { id: string; fullName: string };
};

export type AuditCountImageDto = {
  id: string;
  countId: string;
  mimeType: string;
  sizeBytes: number;
  uploadedBy: string;
  uploadedByName: string;
  createdAt: Date;
  updatedAt: Date;
  /** Short-lived signed link (5 minutes). Null when storage could not sign it. */
  url: string | null;
};

/** An uploaded file that passed validation and is ready to be stored. */
export type PreparedAuditImage = { buffer: Buffer; mimeType: string; extension: string };

/** Reading never fails because Storage is down: the metadata is still returned with url = null. */
async function signUrls(paths: string[]): Promise<Map<string, string>> {
  try {
    return await createSignedUrls(paths);
  } catch (error) {
    console.warn("Could not sign audit count image links.", error);
    return new Map();
  }
}

function toDto(row: ImageRow, urls: Map<string, string>): AuditCountImageDto {
  return {
    id: row.id,
    countId: row.countId,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    uploadedBy: row.uploadedBy,
    uploadedByName: row.uploadedByUser.fullName,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    url: urls.get(row.storagePath) ?? null,
  };
}

/**
 * Evidence photos of one counter's audit count.
 *
 * They are written together with the count (see AuditService.updateCount) and cannot be changed
 * afterwards. This service only validates new files and reads existing ones.
 */
export class AuditImageService {
  /**
   * Checks every file before anything is stored: at most 10 images, each a real JPEG, PNG or WebP.
   *
   * An empty list is allowed: only broken goods need photos, and the caller decides whether a
   * photo is required for the count it is saving.
   */
  prepareImages(files: { buffer: Buffer }[] | undefined): PreparedAuditImage[] {
    if (!files || files.length === 0) return [];
    if (files.length > MAX_IMAGES_PER_COUNT) {
      throw new HttpError(400, `Một lần đếm có tối đa ${MAX_IMAGES_PER_COUNT} ảnh.`);
    }
    return files.map((file) => {
      const detected = file.buffer.length > 0 ? detectImageType(file.buffer) : null;
      if (!detected) {
        throw new HttpError(415, "Chỉ chấp nhận ảnh JPEG, PNG hoặc WebP.");
      }
      return { buffer: file.buffer, mimeType: detected.mimeType, extension: detected.extension };
    });
  }

  /** Non-deleted images of one count with signed links. */
  async listImagesForCount(businessId: string, countId: string): Promise<AuditCountImageDto[]> {
    const rows = await prisma.stockAuditItemCountImage.findMany({
      // A filed photo belongs to a history entry, so it is no longer part of the live gallery.
      where: { businessId, countId, deletedAt: null, archivedAt: null },
      select: IMAGE_SELECT,
      orderBy: { createdAt: "asc" },
    });
    const urls = await signUrls(rows.map((row) => row.storagePath));
    return rows.map((row) => toDto(row, urls));
  }

  /**
   * The photos filed under one history entry.
   *
   * These are the evidence that was collected before the row was approved, rejected or sent back
   * for another count. They keep their own count, so only the counter who took them and the owner
   * may read them.
   */
  async listImagesForHistory(businessId: string, historyId: string): Promise<AuditCountImageDto[]> {
    const rows = await prisma.stockAuditItemCountImage.findMany({
      where: { businessId, historyId, deletedAt: null },
      select: IMAGE_SELECT,
      orderBy: { createdAt: "asc" },
    });
    const urls = await signUrls(rows.map((row) => row.storagePath));
    return rows.map((row) => toDto(row, urls));
  }

  /**
   * The photos of every history entry of a row, with signed links.
   *
   * The history of a row can hold several moments, each with its own photos. They are signed in
   * one go so the page needs a single request instead of one per photo.
   */
  async listImagesForHistories(
    businessId: string,
    historyIds: string[],
  ): Promise<Map<string, AuditCountImageDto[]>> {
    const result = new Map<string, AuditCountImageDto[]>();
    if (historyIds.length === 0) return result;

    const rows = await prisma.stockAuditItemCountImage.findMany({
      where: { businessId, historyId: { in: historyIds }, deletedAt: null },
      select: { ...IMAGE_SELECT, historyId: true },
      orderBy: { createdAt: "asc" },
    });
    const urls = await signUrls(rows.map((row) => row.storagePath));

    for (const historyId of historyIds) result.set(historyId, []);
    for (const row of rows) {
      if (!row.historyId) continue;
      result.get(row.historyId)?.push(toDto(row, urls));
    }
    return result;
  }

  /**
   * Images of one count.
   *
   * The owner may look at every count of the business. A staff member only sees their own count:
   * the other counter's photos would break the blind count, so they are not sent at all.
   */
  async listImages(
    businessId: string,
    countId: string,
    viewerId: string,
    viewerIsOwner: boolean,
  ): Promise<AuditCountImageDto[]> {
    assertUuid(countId, "Count");
    const count = await prisma.stockAuditItemCount.findFirst({
      where: { id: countId, item: { audit: { businessId } } },
      select: { id: true, counterUserId: true },
    });
    if (!count) {
      throw new HttpError(404, "Không tìm thấy lần đếm của dòng kiểm kê này.");
    }
    if (!viewerIsOwner && count.counterUserId !== viewerId) {
      throw new HttpError(403, "Chỉ chủ cửa hàng hoặc người đếm mới xem được ảnh bằng chứng này.");
    }
    return this.listImagesForCount(businessId, countId);
  }

  async getImage(
    businessId: string,
    imageId: string,
    viewerId: string,
    viewerIsOwner: boolean,
  ): Promise<AuditCountImageDto> {
    assertUuid(imageId, "Image");
    const row = await prisma.stockAuditItemCountImage.findFirst({
      where: { id: imageId, businessId, deletedAt: null },
      select: { ...IMAGE_SELECT, count: { select: { counterUserId: true } } },
    });
    if (!row) {
      throw new HttpError(404, "Không tìm thấy ảnh.");
    }
    if (!viewerIsOwner && row.count.counterUserId !== viewerId) {
      throw new HttpError(403, "Chỉ chủ cửa hàng hoặc người đếm mới xem được ảnh bằng chứng này.");
    }
    const urls = await signUrls([row.storagePath]);
    return toDto(row, urls);
  }
}
