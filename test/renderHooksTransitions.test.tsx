/** @jest-environment jsdom */
import * as React from 'react';
import ReactDOM from 'react-dom';
import { act } from 'react-dom/test-utils';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import { GameInfoView } from '../src/components/panels/GameInfoView/GameInfoView';
import AnswerValidationButtons from '../src/components/tableContext/AnswerValidationButtons/AnswerValidationButtons';
import AnswerValidationBody from '../src/components/gameTable/AnswerValidationBody/AnswerValidationBody';
import { ErrorView } from '../src/components/views/Error/ErrorView';
import { useAppDispatch, useAppSelector } from '../src/state/hooks';

jest.mock('../src/state/hooks', () => ({ useAppDispatch: jest.fn(), useAppSelector: jest.fn() }));
jest.mock('../src/components/panels/AuthModeSelector/AuthModeSelector', () => () => null);
jest.mock('../src/components/panels/NameInput/NameInput', () => () => null);
jest.mock('../src/components/common/ClickableAnswer/ClickableAnswer', () => ({ __esModule: true, default: (props: any) => <>{props.text}</> }));
jest.mock('../src/components/common/AutoSizedText/AutoSizedText',
	() => ({ __esModule: true, default: (props: any) => <div className={props.className}>{props.children}</div> }));

let state: any;
let container: HTMLDivElement;

beforeEach(() => {
	state = { user: { login: 'Alice', authName: '' }, online2: { password: '', joinGameProgress: false, gameCreationProgress: false },
		room2: { validation: { queue: [], showExtraRightButtons: false }, settings: { oral: false } },
		common: { isSIHostConnected: true } };
	(useAppDispatch as jest.Mock).mockReturnValue(jest.fn());
	(useAppSelector as jest.Mock).mockImplementation((selector: (value: any) => any) => selector(state));
	container = document.createElement('div');
	document.body.appendChild(container);
});

afterEach(() => { act(() => { ReactDOM.unmountComponentAtNode(container); }); container.remove(); });

test('game info keeps hook order as selection appears and disappears', () => {
	const game = { HostUri: 'http://example', GameID: 1, GameName: 'Room', StartTime: '2026-01-01', RealStartTime: '2026-01-01',
		Persons: [], Rules: '', Mode: 'Tv', Stage: 'Created', ProgressCurrent: 0, ProgressTotal: 0, Language: 'ru-RU',
		Owner: 'Host', PackageName: 'Package', PasswordRequired: false } as any;
	const view = (selected?: any) => <GameInfoView game={selected} showGameName canJoinAsViewer onJoin={() => {}} />;
	act(() => { ReactDOM.render(view(), container); });
	act(() => { ReactDOM.render(view(game), container); });
	expect(container.textContent).toContain('Room');
	act(() => { ReactDOM.render(view(), container); });
	expect(container.textContent).not.toContain('Room');
});

test('validation buttons keep hook order as the queue changes', () => {
	act(() => { ReactDOM.render(<AnswerValidationButtons />, container); });
	expect(container.querySelector('button')).toBeNull();
	state.room2.validation.queue = [{ answer: 'answer', playerIndex: 0 }];
	act(() => { ReactDOM.render(<AnswerValidationButtons />, container); });

	// Without the extra decisions the host judges the answer with two buttons only
	expect(container.querySelectorAll('button')).toHaveLength(2);

	state.room2.validation.showExtraRightButtons = true;
	act(() => { ReactDOM.render(<AnswerValidationButtons />, container); });
	expect(container.querySelectorAll('button')).toHaveLength(7);

	state.room2.validation.queue = [];
	act(() => { ReactDOM.render(<AnswerValidationButtons />, container); });
	expect(container.querySelector('button')).toBeNull();
});

test('validation buttons offer six decisions in an oral game', () => {
	state.room2.settings.oral = true;
	state.room2.validation.queue = [{ answer: '', playerIndex: 0 }];
	state.room2.validation.showExtraRightButtons = true;
	act(() => { ReactDOM.render(<AnswerValidationButtons />, container); });

	const buttons = Array.from(container.querySelectorAll('button')).map(button => button.textContent);

	// Three buttons for a right answer, three for a wrong one and the cancellation between them
	expect(buttons).toEqual(['Yes', '×0.5', '×2', 'Pass', 'No', '×0.5', '×2']);
});

test('validation body hides the empty answer of an oral game', () => {
	const body = (oral: boolean, answer: string) => {
		state.room2.settings.oral = oral;
		state.room2.validation.queue = [{ name: 'Alice', answer }];
		state.room2.validation.rightAnswers = ['right'];
		state.room2.validation.wrongAnswers = [];
		act(() => { ReactDOM.render(<AnswerValidationBody />, container); });
		return container.querySelector('.playerAnswer');
	};

	// The spoken answer is never typed, so an empty block is not shown at all
	expect(body(true, '')).toBeNull();
	expect(body(false, 'typed answer')).not.toBeNull();
	expect(body(false, '')).toBeNull();
});

test('error screen can render both without and with a Redux provider', () => {
	act(() => { ReactDOM.render(<ErrorView error="failed" />, container); });
	expect(container.querySelectorAll('button')).toHaveLength(1);
	const store = configureStore({ reducer: (s = {}) => s });
	act(() => { ReactDOM.render(<Provider store={store}><ErrorView error="failed" /></Provider>, container); });
	expect(container.querySelectorAll('button')).toHaveLength(2);
});
