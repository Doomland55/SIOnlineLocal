/** @jest-environment jsdom */
import * as React from 'react';
import ReactDOM from 'react-dom';
import { act } from 'react-dom/test-utils';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import { GameInfoView } from '../src/components/panels/GameInfoView/GameInfoView';
import AnswerValidationButtons from '../src/components/tableContext/AnswerValidationButtons/AnswerValidationButtons';
import { ErrorView } from '../src/components/views/Error/ErrorView';
import { useAppDispatch, useAppSelector } from '../src/state/hooks';

jest.mock('../src/state/hooks', () => ({ useAppDispatch: jest.fn(), useAppSelector: jest.fn() }));
jest.mock('../src/components/panels/AuthModeSelector/AuthModeSelector', () => () => null);
jest.mock('../src/components/panels/NameInput/NameInput', () => () => null);

let state: any;
let container: HTMLDivElement;

beforeEach(() => {
	state = { user: { login: 'Alice', authName: '' }, online2: { password: '', joinGameProgress: false, gameCreationProgress: false },
		room2: { validation: { queue: [], showExtraRightButtons: false } }, common: { isSIHostConnected: true } };
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
	expect(container.querySelectorAll('button')).toHaveLength(2);
	state.room2.validation.queue = [];
	act(() => { ReactDOM.render(<AnswerValidationButtons />, container); });
	expect(container.querySelector('button')).toBeNull();
});

test('error screen can render both without and with a Redux provider', () => {
	act(() => { ReactDOM.render(<ErrorView error="failed" />, container); });
	expect(container.querySelectorAll('button')).toHaveLength(1);
	const store = configureStore({ reducer: (s = {}) => s });
	act(() => { ReactDOM.render(<Provider store={store}><ErrorView error="failed" /></Provider>, container); });
	expect(container.querySelectorAll('button')).toHaveLength(2);
});
