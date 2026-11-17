import { ContentItem, Question } from '../../../src/model/siquester/package';
import { escapeNewLines } from '../protocol';

/** A single piece of question content prepared for broadcasting. */
export interface ContentAtom {
	/** Placement: screen, replic or background. */
	placement: 'screen' | 'replic' | 'background';

	/** Content type: text, image, audio, video, html. */
	type: string;

	/** Text value for text atoms, media url for media atoms. */
	value: string;

	/** Duration in tenths of a second (100 ms), as expected by the protocol. */
	duration: number;

	/** Should the game wait for the atom duration (or media end) before moving on. */
	waitForFinish: boolean;

	/** Should the atom be excluded from the content preload list (background audio). */
	isBackground: boolean;

	/** A media item with no fixed duration waits for a client playback completion. */
	waitForMediaEnd?: boolean;

	/**
	 * The button may be pressed only after this delay (seconds). A video or an audio question
	 * asks for an answer in the middle of the playback, and a fixed `duration` in the package
	 * postpones the button until the media has actually played for that time.
	 */
	pressDelay?: number;
}

/** An answer option of a question. */
export interface AnswerOptionPlan {
	/** Option label (A, B, C…). */
	label: string;

	/** Option content type: `text` or `image`. */
	type: string;

	/** Option content value: text or url. */
	value: string;
}

const DEFAULT_TEXT_CHARACTER_DURATION = 0.06; // seconds per character
const MIN_TEXT_DURATION = 1; // seconds
const MAX_TEXT_DURATION = 30; // seconds
const DEFAULT_MEDIA_DURATION = 3; // seconds for images/html without explicit duration

/** Converts a `hh:mm:ss` duration string into seconds. */
export function parseDuration(value: string | undefined): number {
	if (!value) {
		return 0;
	}

	const parts = value.split(':').map(part => Number(part));

	if (parts.some(part => !Number.isFinite(part))) {
		return 0;
	}

	if (parts.length === 3) {
		return parts[0] * 3600 + parts[1] * 60 + parts[2];
	}

	if (parts.length === 2) {
		return parts[0] * 60 + parts[1];
	}

	return parts[0] ?? 0;
}

/** Calculates reading time for a text. */
export function getTextDuration(text: string, readingSpeed: number): number {
	const perCharacter = readingSpeed > 0 ? 1 / readingSpeed : DEFAULT_TEXT_CHARACTER_DURATION;

	return Math.min(MAX_TEXT_DURATION, Math.max(MIN_TEXT_DURATION, Math.round(text.length * perCharacter)));
}

/** Resolves media references of a content item. */
export type MediaResolver = (item: ContentItem) => { type: string; value: string } | null;


/** Builds the ordered list of content atoms of a question. */
export function buildContentAtoms(
	question: Question,
	readingSpeed: number,
	resolveMedia: MediaResolver,
	/** Known duration of a media file (seconds) or null when it could not be determined. */
	getMediaDuration?: (item: ContentItem) => number | null,
): ContentAtom[] {
	const atoms: ContentAtom[] = [];
	const items = question.params.question?.items ?? [];

	for (const item of items) {
		const explicitDuration = parseDuration(item.duration);
		const waitForFinish = item.waitForFinish !== false;

		if (item.type === 'text') {
			const duration = explicitDuration > 0 ? explicitDuration : getTextDuration(item.value, readingSpeed);

			atoms.push({
				placement: item.placement === 'replic' ? 'replic' : 'screen',
				type: 'text',
				value: item.value,
				duration: Math.round(duration * 10),
				waitForFinish,
				isBackground: false,
				pressDelay: 0,
			});

			continue;
		}

		const resolved = resolveMedia(item);

		if (!resolved) {
			atoms.push({
				placement: 'screen',
				type: 'text',
				value: item.isRef === false ? item.value : `Не найден файл: ${item.value}`,
				duration: Math.round(MIN_TEXT_DURATION * 10),
				waitForFinish: true,
				isBackground: false,
				pressDelay: 0,
			});

			continue;
		}

		const isMedia = resolved.type === 'video' || resolved.type === 'audio';
		const mediaDuration = isMedia && explicitDuration <= 0 ? (getMediaDuration?.(item) ?? null) : null;
		const duration = explicitDuration > 0
			? explicitDuration
			: mediaDuration && mediaDuration > 0 ? mediaDuration : DEFAULT_MEDIA_DURATION;

		atoms.push({
			placement: item.placement === 'background' ? 'background' : 'screen',
			type: resolved.type,
			value: resolved.value,
			duration: Math.round(duration * 10),
			waitForFinish,
			isBackground: item.placement === 'background' || resolved.type === 'audio',
			// A video or a sound question is answered while it plays: the button appears in the middle.
			// An explicit `duration` is a promise that the interesting part lasts that long,
			// so the button waits for it instead of appearing too early.
			// A background media is not the content of the question, so the button does not wait for it
			pressDelay: isMedia && item.placement !== 'background'
				? (explicitDuration > 0 ? explicitDuration : duration / 2)
				: 0,
		});
	}

	return atoms;
}

/** Builds answer options of a question. */
export function buildAnswerOptions(question: Question, resolveMedia: MediaResolver): AnswerOptionPlan[] {
	const answerOptions = question.params.answerOptions;

	if (!answerOptions) {
		return [];
	}

	const options: AnswerOptionPlan[] = [];
	const keys = Object.keys(answerOptions);

	for (let i = 0; i < keys.length; i += 1) {
		const param = answerOptions[keys[i]];
		const item = param.items[0];

		if (!item) {
			continue;
		}

		const label = keys[i];

		if (item.type === 'text') {
			options.push({ label, type: 'text', value: item.value });
			continue;
		}

		const resolved = resolveMedia(item);

		if (resolved) {
			options.push({ label, type: resolved.type, value: resolved.value });
		} else {
			options.push({ label, type: 'text', value: item.value });
		}
	}

	return options;
}

/** Returns the content of the answer atom of the question (if any). */
export function getAnswerContentAtoms(
	question: Question,
	readingSpeed: number,
	resolveMedia: MediaResolver,
): ContentAtom[] {
	const items = question.params.answer?.items ?? [];

	return items.map(item => {
		const duration = parseDuration(item.duration);
		const resolved = item.type === 'text' ? { type: 'text', value: item.value } : resolveMedia(item);
		const type = resolved?.type ?? 'text';
		const isMedia = type === 'video' || type === 'audio';
		return {
			placement: type === 'audio' ? 'background' as const : 'screen' as const,
			type,
			value: resolved?.value ?? item.value,
			duration: Math.round((duration || (type === 'text' ? getTextDuration(item.value, readingSpeed) : DEFAULT_MEDIA_DURATION)) * 10),
			waitForFinish: item.waitForFinish !== false,
			isBackground: type === 'audio' || item.placement === 'background',
			waitForMediaEnd: isMedia && duration <= 0,
		};
	});
}

/** Formats a message value list for the `CONTENT` message. */
export function buildContentMessageArgs(atoms: ContentAtom[]): string[] {
	return atoms.flatMap(atom => [
		atom.placement as string,
		'0',
		atom.type,
		atom.type === 'text' ? escapeNewLines(atom.value) : atom.value,
	]);
}
