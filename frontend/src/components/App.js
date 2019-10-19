// Imports - React
import React, {Component} from 'react';
// Imports - Redux
import connect from 'react-redux/es/connect/connect';
// Imports - Frameworks (Semantic-UI and Material-UI)
import {Container, Message} from 'semantic-ui-react';
import Grid from '@material-ui/core/Grid';
import {withStyles} from '@material-ui/core';
// Imports - Components
import Header from './Header';
import Mixer from './Mixer';
import Notifier from './Notifier';
// Imports - Actions (Redux)
import {initializeWeb3, initializeAccounts} from '../actions';

import getWeb3 from '../utils/getWeb3';
import SaladContract from '../build/smart_contracts/Salad';

const styles = theme => ({
  root: {
    flexGrow: 1,
  },
  paper: {
    padding: theme.spacing(2),
    textAlign: 'center',
    color: theme.palette.text.secondary,
  },
});

class App extends Component {
  constructor(props) {
    super(props);
    this.state = {
      isUnsupportedNetwork: null,
    };
  }

  async componentDidMount() {
    const web3 = await getWeb3();
    const accounts = await web3.eth.getAccounts();
    this.props.initializeWeb3(web3);
    this.props.initializeAccounts(accounts);

    if (!SaladContract.networks[this.props.web3.networkId]) {
      this.setState({ isUnsupportedNetwork: true });
    }
  }

  render() {
    if (!this.props.web3) {
      return (
        <div className="App">
          <Header/>
          <br/><br/><br/><br/>
          <Grid container spacing={3}>
            <Grid item xs={3}/>
            <Grid item xs={6} style={{textAlign: 'center'}}>
              <Message color="grey">Please allow account authorization in your MetaMask.</Message>
            </Grid>
          </Grid>
        </div>
      );
    }
    if (this.state.isUnsupportedNetwork) {
      const networks = {
        1: 'Mainnet',
        2: 'Morden',
        3: 'Ropsten',
        4: 'Rinkeby',
      };
      return (
        <div className="App">
          <Header/>
          <br/><br/><br/><br/>
          <Grid container spacing={3}>
            <Grid item xs={3}/>
            <Grid item xs={6} style={{textAlign: 'center'}}>
              <Message color="grey">
                Network <b>{networks[this.props.web3.networkId] || this.props.web3.networkId}</b> is not supported.<br />
                Please choose another one and refresh the page.
              </Message>
            </Grid>
          </Grid>
        </div>
      );
    }
    return (
      <div className="App">
        <Header/>
        <Notifier/>
        <br/><br/><br/><br/>
        <Container>
          <Mixer />
        </Container>
      </div>
    );
  }
}

const mapStateToProps = (state) => {
  return {
    web3: state.web3,
  }
};

export default connect(
  mapStateToProps,
  {initializeWeb3, initializeAccounts}
)(withStyles(styles)(App));
