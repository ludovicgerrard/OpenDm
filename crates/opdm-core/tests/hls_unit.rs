// HLS unit tests: AES-128-CBC round trip + playlist attribute parsing.
//! These run fast and pin the exact bugs found in e2e development.
use aes::Aes128;
use cbc::cipher::{block_padding::Pkcs7, BlockDecryptMut, BlockEncryptMut, KeyIvInit};

#[test]
fn debug_hls_crypto_and_parse() {
    type Enc = cbc::Encryptor<Aes128>;
    type Dec = cbc::Decryptor<Aes128>;

    let key = [0x2bu8; 16];
    let iv_hex = "000102030405060708090a0b0c0d0e0f";
    let mut iv = [0u8; 16];
    for (i, pair) in iv_hex.as_bytes().chunks(2).enumerate() {
        iv[i] = u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap();
    }
    assert_eq!(iv, [0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15], "test iv construction");

    let p: Vec<u8> = (0..70_000usize).map(|i| ((i % 7) + 1) as u8).collect();
    let ct = Enc::new_from_slices(&key, &iv).unwrap().encrypt_padded_vec_mut::<Pkcs7>(&p);
    let back = Dec::new_from_slices(&key, &iv).unwrap().decrypt_padded_vec_mut::<Pkcs7>(&ct).unwrap();
    assert_eq!(back, p, "crypto round trip must be lossless");

    // engine help function must decode this ciphertext
    let via_engine = opdm_core::hls::decrypt_seg(&key, &iv, &ct).unwrap();
    assert_eq!(via_engine, p, "engine decrypt must reproduce plaintext");

    // parse the same media playlist the e2e server serves
    let media =
        "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:77\n\
         #EXT-X-KEY:METHOD=AES-128,URI=\"/key\",IV=0x000102030405060708090a0b0c0d0e0f\n\
         #EXTINF:4.0,\n/media/seg0.ts\n#EXTINF:4.0,\n/media/seg1.ts\n#EXTINF:4.0,\n/media/seg2.ts\n#EXT-X-ENDLIST\n";
    let base = url::Url::parse("http://127.0.0.1:1/media/media_1080.m3u8").unwrap();
    let (init, segs, key_spec, seq) = opdm_core::hls::parse_media(media, &base);
    assert!(init.is_none());
    assert_eq!(seq, 77);
    assert_eq!(segs.len(), 3);
    let k = key_spec.expect("key parsed");
    assert!(k.uri.ends_with("/key"), "key uri joined: {}", k.uri);
    assert_eq!(k.iv, Some([0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15]), "engine parsed IV");
}
