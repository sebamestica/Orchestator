/**
 * Icono y color de un archivo por su extensión. Tomado de studyapp (`shared/utils/file-glyph.ts`); las marcas
 * propias de Office y PDF de allá se cambian por iconos de lucide.
 */
import { File as FileIcon, FileArchive, FileAudio, FileCode, FileImage, FileSpreadsheet, FileText, FileVideo, Presentation, type LucideIcon } from 'lucide-react';

export interface FileGlyph {
  Icon: LucideIcon;
  className: string;
}

const GLYPHS: ReadonlyArray<readonly [RegExp, FileGlyph]> = [
  [/\.(xlsx|xlsm|xls|ods|numbers|csv|tsv)$/i, { Icon: FileSpreadsheet, className: 'text-emerald-600 dark:text-emerald-400' }],
  [/\.(pptx|pptm|ppt|odp|key)$/i, { Icon: Presentation, className: 'text-orange-600 dark:text-orange-400' }],
  [/\.(docx|docm|doc|odt|rtf|pages|pdf)$/i, { Icon: FileText, className: 'text-sky-600 dark:text-sky-400' }],
  [/\.(png|jpe?g|gif|webp|avif|bmp|tiff?|svg|ico|heic|heif)$/i, { Icon: FileImage, className: 'text-violet-600 dark:text-violet-400' }],
  [/\.(mp4|mkv|mov|avi|webm|m4v|mpe?g|wmv)$/i, { Icon: FileVideo, className: 'text-fuchsia-600 dark:text-fuchsia-400' }],
  [/\.(mp3|wav|ogg|oga|flac|aac|m4a|opus|weba)$/i, { Icon: FileAudio, className: 'text-teal-600 dark:text-teal-400' }],
  [/\.(zip|rar|7z|tar|gz|tgz|bz2|xz|zst)$/i, { Icon: FileArchive, className: 'text-amber-600 dark:text-amber-400' }],
  [/\.(ts|tsx|js|jsx|mjs|cjs|json|jsonc|py|rb|go|rs|java|kt|swift|c|h|cc|cpp|hpp|cs|php|sh|bash|ps1|sql|html?|css|scss|toml|ini|xml|ya?ml)$/i, { Icon: FileCode, className: 'text-indigo-600 dark:text-indigo-400' }],
];

const TEXTUAL: FileGlyph = { Icon: FileText, className: 'text-muted' };
const TEXTUAL_NAME = /\.(md|mdx|markdown|txt|text|log|tex|srt|vtt|rst|org)$/i;
const FALLBACK: FileGlyph = { Icon: FileIcon, className: 'text-muted' };

export function fileGlyphOf(name: string): FileGlyph {
  if (TEXTUAL_NAME.test(name)) return TEXTUAL;
  return GLYPHS.find(([pattern]) => pattern.test(name))?.[1] ?? FALLBACK;
}
