import * as React from 'react';
import { connect, ReactReduxContext, ReactReduxContextValue } from 'react-redux';
import { AppDispatch } from '../../../state/store';
import localization from '../../../model/resources/localization';
import { copyToClipboard } from '../../../state/globalActions';

import './ErrorView.css';

interface ErrorViewProps {
	error: string | null;
}

// TODO: provide a button to send error to the server

export function ErrorView(props: ErrorViewProps): JSX.Element {
	// This view is also rendered directly if initialization fails before a Provider exists.
	const reduxContext = React.useContext(ReactReduxContext) as ReactReduxContextValue | null;
	const appDispatch: AppDispatch | null = reduxContext ? reduxContext.store.dispatch as AppDispatch : null;

	const copyTextToClipboard = () => {
		if (props.error && appDispatch) {
			appDispatch(copyToClipboard(props.error));
		}
	};

	return (
		<div className='errorView'>
			<div className='errorBox'>
				<header className="errorTitle"><h1>{localization.errorHappened}</h1></header>
				<div className='errorBody'>{props.error}</div>

				<div className='buttons'>
					{appDispatch ? <button
						type='button'
						className='standard'
						disabled={!props.error}
						onClick={() => copyTextToClipboard()}
					>
						{localization.copyText}
					</button> : null}

					<button
						type='button'
						className='standard'
						disabled={!props.error}
						onClick={() => window.location.reload()}
					>
						{localization.reloadPage}
					</button>
				</div>
			</div>
		</div>
	);
}

export default connect()(ErrorView);
