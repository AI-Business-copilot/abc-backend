import { HttpError } from "../../../shared/http/http-error";
import { detectImageType } from "../../../shared/http/upload.middleware";
import { prisma } from "../../../shared/infrastructure/database/prisma.client";
import { createSignedUrls } from "../../../shared/infrastructure/storage/supabase-storage";
import { assertUuid } from "./scrap-access";

export const MAX_IMAGES_PER_ORDER = 10;

const IMAGE_SELECT = {
  id: true,
  scrapOrderId: true,
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
  scrapOrderId: string;
  storagePath: string;
  mimeType: string;
  sizeBytes: number;
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
  uploadedBy: string;
  uploadedByName: string;
  createdAt: Date;
  updatedAt: Date;
  /** Short-lived signed link (5 minutes). Null when storage could not sign it. */
  url: string | null;
};

/** An uploaded file that passed validation and is ready to be stored. */
export type PreparedImage = { buffer: Buffer; mimeType: string; extension: string };

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
    uploadedBy: row.uploadedBy,
    uploadedByName: row.uploadedByUser.fullName,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    url: urls.get(row.storagePath) ?? null,
  };
}

/**
 * Evidence photos are written once, together with the scrap order (see ScrapService.createScrapOrder).
 * This service only validates new files and reads existing ones; photos cannot be added, changed or removed later.
 */
export class ScrapImageService {
  /** Checks every file before anything is stored: 1 to 10 images, each a real JPEG, PNG or WebP. */
  prepareImages(files: { buffer: Buffer }[] | undefined): PreparedImage[] {
    if (!files || files.length === 0) {
      throw new HttpError(400, "Add at least one evidence photo.");
    }
    if (files.length > MAX_IMAGES_PER_ORDER) {
      throw new HttpError(400, `A scrap order can have at most ${MAX_IMAGES_PER_ORDER} photos.`);
    }
    return files.map((file) => {
      const detected = file.buffer.length > 0 ? detectImageType(file.buffer) : null;
      if (!detected) {
        throw new HttpError(415, "Only JPEG, PNG or WebP images are accepted.");
      }
      return { buffer: file.buffer, mimeType: detected.mimeType, extension: detected.extension };
    });
  }

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
}
