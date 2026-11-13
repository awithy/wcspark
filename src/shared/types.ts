export const MAX_BLURB_LENGTH = 4000;
export const MAX_IMAGES_PER_SPARK = 20;
export const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
export const DEFAULT_PAGE_SIZE = 200;

export interface SparkImage {
  id: string;
  mime: string;
  width: number;
  height: number;
}

export interface Spark {
  id: number;
  blurb: string | null;
  /** Unix epoch milliseconds */
  createdAt: number;
  /** Unix epoch milliseconds */
  updatedAt: number;
  images: SparkImage[];
}

export interface SparkPage {
  sparks: Spark[];
  /** Opaque cursor for the next (older) page, or null when there are no more. */
  nextCursor: string | null;
}

export interface SparkInput {
  blurb: string | null;
  imageIds: string[];
}

export const imageUrl = (id: string) => `/files/${id}`;
export const thumbUrl = (id: string) => `/files/${id}/thumb`;
