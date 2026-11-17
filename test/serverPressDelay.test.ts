import { buildContentAtoms, ContentAtom } from '../server/src/game/questionPlan';
import { Question } from '../src/model/siquester/package';

/** Builds a question with a single content item. */
function buildQuestion(item: Record<string, string>, type = 'ordinary'): Question {
	return {
		type,
		price: 100,
		params: {
			question: { items: [{ placement: 'screen', ...item }] },
		},
		right: { answer: ['Ответ'] },
	} as unknown as Question;
}

/** The resolver of the local server: media of the package becomes a public url. */
const resolveMedia = (item: { type: string; value: string }) => ({ type: item.type, value: `/package/test/${item.value}` });

describe('Press delay of media questions', () => {
	it('waits for the half of a real video duration', () => {
		const atoms = buildContentAtoms(buildQuestion({ type: 'video', value: 'video.mp4' }), 20, resolveMedia, () => 8);

		expect(atoms).toHaveLength(1);
		expect(atoms[0].duration).toBeCloseTo(80, 5);
		expect(atoms[0].pressDelay).toBeCloseTo(4, 5);
	});

	it('waits for the explicit duration of the item', () => {
		const atoms = buildContentAtoms(
			buildQuestion({ type: 'video', value: 'video.mp4', duration: '00:00:02' }),
			20,
			resolveMedia,
			() => 10,
		);

		// The package asks to show the item for two seconds, so the button waits for that time
		expect(atoms[0].pressDelay).toBeCloseTo(2, 5);
	});

	it('treats a sound like a video', () => {
		const atoms = buildContentAtoms(buildQuestion({ type: 'audio', value: 'sound.mp3' }), 20, resolveMedia, () => 6);
		expect(atoms[0].pressDelay).toBeCloseTo(3, 5);

		const explicit = buildContentAtoms(
			buildQuestion({ type: 'audio', value: 'sound.mp3', duration: '00:00:05' }),
			20,
			resolveMedia,
			() => 6,
		);
		expect(explicit[0].pressDelay).toBeCloseTo(5, 5);
	});

	it('falls back to the default media time when the duration is unknown', () => {
		const atoms = buildContentAtoms(buildQuestion({ type: 'video', value: 'video.mp4' }), 20, resolveMedia, () => null);

		expect(atoms[0].duration).toBeCloseTo(30, 5);
		expect(atoms[0].pressDelay).toBeCloseTo(1.5, 5);
	});

	it('keeps a resolving-less question and text pictures without a delay', () => {
		const question = buildQuestion({ type: 'text', value: 'Просто текст' });
		const atoms: ContentAtom[] = buildContentAtoms(question, 20, resolveMedia, () => 5);

		expect(atoms[0].pressDelay).toBe(0);

		// A media item that the package cannot resolve keeps the old behavior
		const broken = buildContentAtoms(buildQuestion({ type: 'video', value: 'video.mp4' }), 20, () => null, () => 5);
		expect(broken[0].pressDelay).toBe(0);
	});

	it('does not wait for a background media', () => {
		const question = {
			type: 'ordinary',
			price: 100,
			params: {
				question: {
					items: [
						{ placement: 'background', type: 'video', value: 'bg.mp4' },
						{ placement: 'screen', type: 'text', value: 'Вопрос' },
					],
				},
			},
			right: { answer: ['Ответ'] },
		} as unknown as Question;

		const atoms = buildContentAtoms(question, 20, resolveMedia, () => 4);

		expect(atoms.find(atom => atom.placement === 'background')?.pressDelay).toBe(0);
	});
});
