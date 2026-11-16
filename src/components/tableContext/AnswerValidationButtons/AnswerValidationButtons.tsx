import * as React from 'react';
import { useAppDispatch, useAppSelector } from '../../../state/hooks';
import { approveAnswer, rejectAnswer, setAreSumsEditable } from '../../../state/room2Slice';
import localization from '../../../model/resources/localization';

import './AnswerValidationButtons.scss';

/** Score multipliers offered for every decision: the plain answer, half price and double price. */
const FACTORS: { factor: number; extra: boolean; }[] = [
	{ factor: 1.0, extra: false },
	{ factor: 0.5, extra: true },
	{ factor: 2.0, extra: true },
];

function getFactorTitle(factor: number): string {
	switch (factor) {
		case 0.5:
			return localization.halfPrice;

		case 2.0:
			return localization.doublePrice;

		default:
			return localization.fullPrice;
	}
}

function getFactorLabel(factor: number): string {
	return factor === 1.0 ? '' : `×${factor}`;
}

export default function AnswerValidationButtons(): JSX.Element | null {
	const appDispatch = useAppDispatch();
	const validation = useAppSelector(state => state.room2.validation);
	const isConnected = useAppSelector(state => state.common.isSIHostConnected);

	const [firstValidationItem] = validation.queue;

	const [buttonsBlocked, setButtonsBlocked] = React.useState(false);
	const timeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

	React.useEffect(() => () => {
		if (timeoutRef.current) {
			clearTimeout(timeoutRef.current);
		}
	}, []);

	// Nothing to decide: the buttons are shown only while there is an answer to check
	if (!firstValidationItem) {
		return null;
	}

	const blockButtons = () => {
		setButtonsBlocked(true);
		timeoutRef.current = setTimeout(() => setButtonsBlocked(false), 500);
	};

	const onApprove = (factor: number) => {
		appDispatch(approveAnswer({ answer: firstValidationItem.answer, factor }));
		appDispatch(setAreSumsEditable(false));
		blockButtons();
	};

	const onReject = (factor: number) => {
		appDispatch(rejectAnswer({ answer: firstValidationItem.answer, factor }));
		appDispatch(setAreSumsEditable(false));
		blockButtons();
	};

	// The plain decision is always available; the multiplier buttons come with the full set of decisions
	const showExtraButtons = validation.showExtraRightButtons;

	// Every decision has three multipliers: ×1 (the answer itself), ×0.5 and ×2.
	// Three of them are for the right answer and three of them are for the wrong one.
	const renderButtons = (
		onClick: (factor: number) => void,
		buttonClassName: string,
		icon: string,
		accessibleName: string,
	) => FACTORS
		.filter(({ extra }) => !extra || showExtraButtons)
		.map(({ factor, extra }) => (
			<button
				key={factor}
				type="button"
				title={`${getFactorTitle(factor)} — ${accessibleName}`}
				aria-label={`${icon} ${getFactorLabel(factor) || getFactorTitle(factor)}`}
				className={`standard validationButton ${buttonClassName}${extra ? ` extraButton ${factor < 1 ? 'halfPrice' : 'doublePrice'}` : ''}`}
				disabled={!isConnected || buttonsBlocked}
				onClick={() => onClick(factor)}>
				{getFactorLabel(factor) || icon}
			</button>
		));

	return (
		<div className='answerValidationButtons'>
			<div className="buttonsPanel">
				<div className='buttonsArea'>
					{renderButtons(onApprove, 'acceptButton', localization.yes, localization.rightAnswer)}
				</div>

				{showExtraButtons ? (
					<div className='buttonsArea passArea'>
						<button
							type='button'
							className='standard cancelAnswer validationButton'
							title={localization.cancelAnswer}
							onClick={() => onReject(0)}
						>
							{localization.pass}
						</button>
					</div>
				) : null}

				<div className='buttonsArea'>
					{renderButtons(onReject, 'rejectButton', localization.no, localization.wrongAnswer)}
				</div>
			</div>
		</div>
	);
}
