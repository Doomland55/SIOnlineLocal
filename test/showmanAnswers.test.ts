import MessageHandler from '../src/logic/messageProcessor';
import ClientController from '../src/logic/ClientController';
import Role from '../src/client/models/Role';

describe('Showman answer hints', () => {
	it('decodes and delivers correct and wrong answers only to the showman', () => {
		const onQuestionAnswers = jest.fn();
		const controller = { getRole: () => Role.Showman, onQuestionAnswers } as unknown as ClientController;
		const handler = new MessageHandler(controller);
		handler.processMessage({ IsSystem: true, Sender: '@', Text: 'QUESTION_ANSWERS\n3\nline\\ntwo\nother\npath\\\\name\nwrong' });
		expect(onQuestionAnswers).toHaveBeenCalledWith(['line\ntwo', 'other', 'path\\name'], ['wrong']);
		handler.processMessage({ IsSystem: true, Sender: '@', Text: 'QUESTION_ANSWERS\n0' });
		expect(onQuestionAnswers).toHaveBeenLastCalledWith([], []);
		const playerController = { getRole: () => Role.Player, onQuestionAnswers } as unknown as ClientController;
		new MessageHandler(playerController).processMessage({ IsSystem: true, Sender: '@', Text: 'QUESTION_ANSWERS\n1\nsecret' });
		expect(onQuestionAnswers).toHaveBeenCalledTimes(2);
	});
});
