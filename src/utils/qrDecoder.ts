import jsQR from "jsqr";

/**
 * Decodes a QR code from a user-uploaded image file (PNG, JPG, WEBP, etc.).
 * Scales down large images for fast decoding on smartphones.
 */
export async function decodeQrFromImageFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onerror = () => {
      reject(new Error("Error reading image file."));
    };

    reader.onload = () => {
      const img = new Image();

      img.onerror = () => {
        reject(new Error("Could not load image. Unsupported format."));
      };

      img.onload = () => {
        try {
          const canvas = document.createElement("canvas");
          let width = img.naturalWidth || img.width;
          let height = img.naturalHeight || img.height;

          if (!width || !height) {
            reject(new Error("Invalid image dimensions."));
            return;
          }

          // Scale down if image is huge (e.g. 48MP smartphone photo)
          const MAX_DIM = 1600;
          if (width > MAX_DIM || height > MAX_DIM) {
            if (width > height) {
              height = Math.round((height * MAX_DIM) / width);
              width = MAX_DIM;
            } else {
              width = Math.round((width * MAX_DIM) / height);
              height = MAX_DIM;
            }
          }

          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext("2d", { willReadFrequently: true });

          if (!ctx) {
            reject(new Error("Could not initialize 2D canvas context."));
            return;
          }

          ctx.drawImage(img, 0, 0, width, height);
          const imageData = ctx.getImageData(0, 0, width, height);

          const result = jsQR(imageData.data, imageData.width, imageData.height, {
            inversionAttempts: "attemptBoth",
          });

          if (result && result.data) {
            resolve(result.data);
          } else {
            reject(new Error("NO_QR_FOUND"));
          }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          reject(new Error(msg));
        }
      };

      img.src = reader.result as string;
    };

    reader.readAsDataURL(file);
  });
}

/**
 * Attempts to decode a QR code from an image in the clipboard.
 * Reads the first image item from navigator.clipboard.
 */
export async function decodeQrFromClipboard(): Promise<string> {
  if (!navigator.clipboard || !navigator.clipboard.read) {
    throw new Error("CLIPBOARD_NOT_SUPPORTED");
  }

  const items = await navigator.clipboard.read();
  for (const item of items) {
    const imageType = item.types.find((t) => t.startsWith("image/"));
    if (imageType) {
      const blob = await item.getType(imageType);
      const file = new File([blob], "clipboard.png", { type: imageType });
      return decodeQrFromImageFile(file);
    }
  }

  // Try reading as text (maybe they copied a pdvault:// URI)
  try {
    const text = await navigator.clipboard.readText();
    if (text && text.trim().startsWith("pdvault://")) {
      return text.trim();
    }
  } catch {
    // ignore
  }

  throw new Error("NO_IMAGE_IN_CLIPBOARD");
}
