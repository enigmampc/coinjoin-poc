// Rust’s standard library provides a lot of useful functionality, but assumes support for various
// features of its host system: threads, networking, heap allocation, and others. SGX environments
// do not have these features, so we tell Rust that we don’t want to use the standard library
#![no_std]
#![allow(unused_attributes)]

#[macro_use]
extern crate serde_derive;
extern crate serde;
// The eng_wasm crate allows to use the Enigma runtime, which provides:
//     - Read from state      read_state!(key)
//     - Write to state       write_state!(key => value)
//     - Print                eprint!(...)
extern crate eng_wasm;

// The eng_wasm_derive crate provides the following
//     - Functions exposed by the contract that may be called from the Enigma network
//     - Ability to call functions of ethereum contracts from ESC
extern crate eng_wasm_derive;

// The asymmetric features of enigma_crypto
extern crate enigma_crypto;

// Serialization stuff
extern crate rustc_hex;

// eng_wasm
use eng_wasm::*;
use eng_wasm_derive::pub_interface;
use eng_wasm_derive::eth_contract;
use eng_wasm::{String, H256, H160, Vec, U256};
use rustc_hex::ToHex;
use enigma_crypto::asymmetric::KeyPair;

// Mixer contract abi
#[eth_contract("IMixer.json")]
struct EthContract;

// State key name "mixer_eth_addr" holding eth address of Mixer contract
static MIXER_ETH_ADDR: &str = "mixer_eth_addr";
static ENCRYPTION_KEY: &str = "encryption_key";
const ENC_RECIPIENT_SIZE: usize = 70;

// For contract-exposed functions, declare such functions under the following public trait:
#[pub_interface]
pub trait ContractInterface {
    fn construct(mixer_eth_addr: H160);
    fn get_pub_key() -> Vec<u8>;
    fn execute_deal(deal_id: H256, nb_recipients: U256, enc_recipients: Vec<u8>) -> Vec<H160>;
}

// The implementation of the exported ESC functions should be defined in the trait implementation
// for a new struct.
// #[no_mangle] modifier is required before each function to turn off Rust's name mangling, so that
// it is easier to link to. Sets the symbol for this item to its identifier.
pub struct Contract;

// Private functions accessible only by the secret contract
impl Contract {
    // Read voting address of VotingETH contract
    fn get_mixer_eth_addr() -> String {
        read_state!(MIXER_ETH_ADDR).unwrap_or_default()
    }

    fn get_pkey() -> SymmetricKey {
        let key = read_state!(ENCRYPTION_KEY).unwrap();
        eprint!("Got key: {:?}", key);
        key
    }

    fn decrypt(enc_msg: &Vec<u8>) -> Vec<u8> {
        let key = Self::get_pkey();
        eprint!("Decrypting bytes ({:?})", enc_msg);
        decrypt(enc_msg, &key)
    }

    fn encrypt(plaintext_msg: &Vec<u8>) -> Vec<u8> {
        let key = Self::get_pkey();
        eprint!("Encrypting bytes ({:?})", plaintext_msg);
        encrypt(plaintext_msg, &key)
    }
}

impl ContractInterface for Contract {
    // Constructor function that takes in VotingETH ethereum contract address
    #[no_mangle]
    fn construct(mixer_eth_addr: H160) {
        let mixer_eth_addr_str: String = mixer_eth_addr.to_hex();
        write_state!(MIXER_ETH_ADDR => mixer_eth_addr_str);

        // Create new random encryption key
        let key = generate_key();
        write_state!(ENCRYPTION_KEY => key);
    }

    #[no_mangle]
    fn get_pub_key() -> Vec<u8> {
        eprint!("====> in get_pub_key");
        let key = Self::get_pkey();
        let key_pair = KeyPair::from_slice(&key).unwrap();
        let pub_key = key_pair.get_pubkey();
        let pub_key_text = pub_key.to_hex::<String>();
        eprint!("The pubKey hex: {}", pub_key_text);
        pub_key.to_vec()
    }

    #[no_mangle]
    fn execute_deal(deal_id: H256, nb_recipients: U256, enc_recipients: Vec<u8>) -> Vec<H160> {
        eprint!("In execute_deal({:?}, {:?}, {:?})", deal_id, nb_recipients, enc_recipients);
        let mut recipients: Vec<H160> = Vec::new();
        let seed = 10;
        for i in 0..nb_recipients.low_u64() as usize {
            let start = i * ENC_RECIPIENT_SIZE;
            let end = (i + 1) * ENC_RECIPIENT_SIZE;
            let mut enc_recipient = [0; ENC_RECIPIENT_SIZE];
            enc_recipient.copy_from_slice(&enc_recipients[start..end]);
            eprint!("The encrypted recipient: {:?}", enc_recipient.to_vec());
//            let result = Self::decrypt(&enc_recipient.to_vec());
//            eprint!("The decrypted addresses: {}", result.to_hex::<String>());
            let recipient = H160::from(&enc_recipient[0..20]);
            recipients.push(recipient);
        }
        eprint!("The ordered recipients: {:?}", recipients);
        for i in (0..recipients.len()).rev() {
            let j = seed % (i + 1);
            let recipient = recipients[j];
            recipients[j] = recipients[i];
            recipients[i] = recipient;
        }
        eprint!("The mixed recipients: {:?}", recipients);
//        eprint!("Mixing address for deal: {:?}", deal_id);
//        let mixer_eth_addr: String = Self::get_mixer_eth_addr();
//        let eth_contract = EthContract::new(&mixer_eth_addr);
//        let deal_id_uint = U256::from(deal_id);
//        eth_contract.distribute(deal_id_uint, recipients.clone());
        recipients
    }
}