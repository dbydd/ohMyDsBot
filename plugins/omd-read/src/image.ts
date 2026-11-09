/**
 * Image detection and the model-facing envelope for an image read.
 *
 * `read` returns an image inline when the path names a supported format, so
 * the separate `read_image` tool is not mounted. Names only declare a media
 * type; the attachment service's decode stays authoritative.
 *
 * @module omd-read/image
 */

import { extname } from 'node:path'
import type { ImageMediaType } from '@deepseek-ai/dsh-attachment'

/** Extensions `read` accepts as images. */
const IMAGE_EXTENSIONS: Readonly<Record<string, ImageMediaType>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff] as const

/**
 * Media type declared by a path's extension.
 * @param filePath - the model-supplied path, before resolution.
 * @returns the declared type, or undefined when the extension names no supported format.
 */
export function imageMediaTypeForPath(filePath: string): ImageMediaType | undefined {
  return IMAGE_EXTENSIONS[extname(filePath).toLowerCase()]
}

/**
 * Media type read from a file's leading bytes, extension irrelevant.
 * @param data - the file's leading bytes.
 * @returns the detected type, or undefined when the bytes are not a supported image.
 */
export function sniffImageMediaType(data: Uint8Array): ImageMediaType | undefined {
  const starts = (offset: number, expected: readonly number[]): boolean =>
    data.byteLength >= offset + expected.length && expected.every((byte, index) => data[offset + index] === byte)
  const ascii = (offset: number, value: string): boolean => {
    if (data.byteLength < offset + value.length) return false
    for (let index = 0; index < value.length; index += 1) {
      if (data[offset + index] !== value.charCodeAt(index)) return false
    }
    return true
  }
  if (starts(0, PNG_SIGNATURE)) return 'image/png'
  if (starts(0, JPEG_SIGNATURE)) return 'image/jpeg'
  if (ascii(0, 'GIF87a') || ascii(0, 'GIF89a')) return 'image/gif'
  if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) return 'image/webp'
  return undefined
}

/**
 * Format an image read as the model-facing envelope that sits beside the image block.
 * @param displayPath - the backend-resolved path.
 * @param image - the stored image metadata.
 * @returns the envelope text.
 */
export function formatImageRead(
  displayPath: string,
  image: {
    mediaType: string
    width: number
    height: number
    bytes: number
    originalDimensions?: { width: number; height: number }
  },
): string {
  const original = image.originalDimensions
  const scaled = original === undefined
    ? ''
    : ` (downscaled from ${original.width}x${original.height} px; ${
      (original.width / image.width).toFixed(2) === (original.height / image.height).toFixed(2)
        ? `multiply coordinates by ${(original.width / image.width).toFixed(2)}`
        : `multiply x coordinates by ${(original.width / image.width).toFixed(2)} and y coordinates by ${(original.height / image.height).toFixed(2)}`
    } to locate features in the original file)`
  return `<path>${displayPath}</path>
<type>image</type>
<content>
${image.mediaType} image, ${image.width}x${image.height} px, ${image.bytes} bytes${scaled}
</content>`
}
