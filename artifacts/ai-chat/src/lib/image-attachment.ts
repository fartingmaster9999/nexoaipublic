export const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
export const SUPPORTED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export type SupportedImageType = (typeof SUPPORTED_IMAGE_TYPES)[number];

export type PendingImage = {
  file: File;
  previewUrl: string;
  mimeType: SupportedImageType;
};

function validateImageTypeAndContents(file: File): string | null {
  if (!SUPPORTED_IMAGE_TYPES.includes(file.type as SupportedImageType)) {
    return "Choose a JPEG, PNG, or WebP image.";
  }
  if (file.size === 0) return "That image is empty.";
  return null;
}

export function validateImageFile(file: File): string | null {
  const contentError = validateImageTypeAndContents(file);
  if (contentError) return contentError;
  if (file.size > MAX_IMAGE_BYTES) return "Images must be 3 MB or smaller.";
  return null;
}

/**
 * Prepare a supported image for the server's 3 MB limit without retaining the
 * original bytes in app state. Oversized images are flattened onto white and
 * reduced to JPEG on-device; regular-sized files are left unchanged.
 */
export async function prepareImageFile(file: File): Promise<File> {
  const contentError = validateImageTypeAndContents(file);
  if (contentError) throw new Error(contentError);
  if (file.size <= MAX_IMAGE_BYTES) return file;

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error("This image couldn't be opened. Choose a different JPEG, PNG, or WebP image.");
  }

  try {
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Your browser couldn't prepare this image. Try a different image.");

    const largestOriginalDimension = Math.max(bitmap.width, bitmap.height);
    let scale = Math.min(1, 2560 / largestOriginalDimension);
    const qualities = [0.86, 0.76, 0.66, 0.56, 0.46];

    for (let attempt = 0; attempt < 24; attempt++) {
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      context.fillStyle = "#fff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);

      for (const quality of qualities) {
        const blob = await new Promise<Blob>((resolve, reject) => {
          canvas.toBlob(
            (result) => result ? resolve(result) : reject(new Error("Image encoding failed.")),
            "image/jpeg",
            quality,
          );
        });
        if (blob.type !== "image/jpeg") {
          throw new Error("Your browser couldn't create a supported image. Try a different browser.");
        }
        if (blob.size > 0 && blob.size <= MAX_IMAGE_BYTES) {
          const name = file.name.replace(/\.[^.]*$/, "") || "image";
          return new File([blob], `${name}.jpg`, { type: "image/jpeg", lastModified: file.lastModified });
        }
      }

      scale *= 0.8;
      if (Math.max(bitmap.width * scale, bitmap.height * scale) < 320) break;
    }

    throw new Error("This image couldn't be reduced below 3 MB. Try a different image.");
  } finally {
    bitmap.close();
  }
}

/** Encode only for the transient request body; never add this value to conversation state. */
export async function imageFileToBase64(file: File): Promise<string> {
  const error = validateImageFile(file);
  if (error) throw new Error(error);
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}
