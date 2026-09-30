import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { BannedPhraseSeverity } from '@prisma/client';
import { DomainEvents } from '../common/events/domain-events';
import { PrismaService } from '../common/prisma/prisma.service';

const CACHE_TTL_MS = 30_000;

// Common leetspeak substitutions; a fuzzy pattern also tolerates stray
// separators between letters ("s.p.a.m") - both common evasions for a
// word/phrase filter (plan §6.3).
const LEET_ALTERNATES: Record<string, string> = {
  a: 'a4@',
  e: 'e3',
  i: 'i1!',
  o: 'o0',
  s: 's5$',
  t: 't7',
  b: 'b8',
  g: 'g9',
};

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function toFuzzyPattern(phrase: string): RegExp {
  const body = phrase
    .toLowerCase()
    .split('')
    .map((char) => (/[a-z0-9]/.test(char) ? `[${escapeRegExp(LEET_ALTERNATES[char] ?? char)}]` : null))
    .filter((part): part is string => part !== null)
    .join('[^a-z0-9]*');
  return new RegExp(body, 'gi');
}

interface CachedPhrase {
  phrase: string;
  severity: BannedPhraseSeverity;
  pattern: RegExp;
}

export interface PhraseMatch {
  phrase: string;
  severity: BannedPhraseSeverity;
}

/**
 * Word/phrase filter (plan §6.3, step 2) - a real table (not static config)
 * so it can be updated without a deploy, once Phase 8 adds a CRUD screen
 * over it. The phrase list rarely changes, so it's cached in-process for
 * `CACHE_TTL_MS` rather than queried on every single chat message.
 * See docs/features/moderation.md.
 */
@Injectable()
export class BannedPhrasesService {
  constructor(private readonly prisma: PrismaService) {}

  private cache: CachedPhrase[] | null = null;
  private cachedAt = 0;

  /** Every banned phrase `text` matches (leetspeak/separator-tolerant), REJECT severity first. */
  async match(text: string): Promise<PhraseMatch[]> {
    const phrases = await this.phrases();
    const matches = phrases.filter((entry) => {
      entry.pattern.lastIndex = 0;
      return entry.pattern.test(text);
    });
    return matches
      .map((entry) => ({ phrase: entry.phrase, severity: entry.severity }))
      .sort((a, b) => Number(a.severity !== BannedPhraseSeverity.REJECT) - Number(b.severity !== BannedPhraseSeverity.REJECT));
  }

  /** Blanks out every MASK-severity match. Callers should already have rejected any REJECT-severity one. */
  async mask(text: string): Promise<string> {
    const phrases = await this.phrases();
    let masked = text;
    for (const entry of phrases) {
      if (entry.severity !== BannedPhraseSeverity.MASK) continue;
      masked = masked.replace(entry.pattern, (found) => '*'.repeat(found.length));
    }
    return masked;
  }

  // An edit in the admin console applies to the very next message.
  @OnEvent(DomainEvents.BannedPhraseCreated)
  @OnEvent(DomainEvents.BannedPhraseUpdated)
  @OnEvent(DomainEvents.BannedPhraseDeleted)
  invalidate(): void {
    this.cache = null;
  }

  private async phrases(): Promise<CachedPhrase[]> {
    const now = Date.now();
    if (this.cache && now - this.cachedAt < CACHE_TTL_MS) return this.cache;
    const rows = await this.prisma.bannedPhrase.findMany({ select: { phrase: true, severity: true } });
    this.cache = rows.map((row) => ({
      phrase: row.phrase,
      severity: row.severity,
      pattern: toFuzzyPattern(row.phrase),
    }));
    this.cachedAt = now;
    return this.cache;
  }
}
