// yxpil · BIT
//! OS 原生加密第二层：在 securefile 的 AES 语义流加密（设备密钥）之外，
//! 再用操作系统自带的加密包一遍——Windows 用 DPAPI（CryptProtectData，
//! CurrentUser 域，绑定本机本用户，换机/换用户无法解密）。
//! 非 Windows 无对应零交互机制 → 原样直通（单层），即「没有就不第二遍」。
//!
//! 布局：`[tag u8] + payload`，tag=1 DPAPI 密文，tag=0 原样（非 Windows 或直通）。
//! tag 让 DB 拷贝到其他平台时能明确降级失败而非解出垃圾。

/// 加一层 OS 加密。Windows = DPAPI；其他平台 = 原样直通（单层）。
pub fn protect(plain: &[u8]) -> Vec<u8> {
    #[cfg(windows)]
    {
        if let Some(blob) = dpapi_protect(plain) {
            let mut out = Vec::with_capacity(blob.len() + 1);
            out.push(1);
            out.extend_from_slice(&blob);
            return out;
        }
        // DPAPI 失败极罕见（用户profile 损坏等）：降级为单层，不阻断保存
        eprintln!("[osprotect] DPAPI protect failed, falling back to single layer");
    }
    let mut out = Vec::with_capacity(plain.len() + 1);
    out.push(0);
    out.extend_from_slice(plain);
    out
}

/// 解一层 OS 加密。返回 None = 无法解开（跨平台拷贝 / 篡改 / 用户域变更）。
pub fn unprotect(blob: &[u8]) -> Option<Vec<u8>> {
    let (tag, payload) = blob.split_first()?;
    match tag {
        0 => Some(payload.to_vec()),
        1 => {
            #[cfg(windows)]
            return dpapi_unprotect(payload);
            #[cfg(not(windows))]
            {
                let _ = payload;
                None // Windows 上加密的库拿到非 Windows 平台：明确不可解
            }
        }
        _ => None,
    }
}

#[cfg(windows)]
const ENTROPY: &[u8] = b"BIT::osprotect::v1"; // 应用熵：绑定用途，防止其他程序同名解密

#[cfg(windows)]
fn dpapi_protect(plain: &[u8]) -> Option<Vec<u8>> {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{CryptProtectData, CRYPT_INTEGER_BLOB};
    unsafe {
        let input = CRYPT_INTEGER_BLOB {
            cbData: plain.len() as u32,
            pbData: plain.as_ptr() as *mut _,
        };
        let entropy = CRYPT_INTEGER_BLOB {
            cbData: ENTROPY.len() as u32,
            pbData: ENTROPY.as_ptr() as *mut _,
        };
        let mut out = CRYPT_INTEGER_BLOB { cbData: 0, pbData: std::ptr::null_mut() };
        if CryptProtectData(
            &input,
            std::ptr::null(),
            &entropy,
            std::ptr::null(),
            std::ptr::null(),
            0,
            &mut out,
        ) == 0
        {
            return None;
        }
        let slice = std::slice::from_raw_parts(out.pbData, out.cbData as usize);
        let v = slice.to_vec();
        LocalFree(out.pbData as _);
        Some(v)
    }
}

#[cfg(windows)]
fn dpapi_unprotect(blob: &[u8]) -> Option<Vec<u8>> {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{CryptUnprotectData, CRYPT_INTEGER_BLOB};
    unsafe {
        let input = CRYPT_INTEGER_BLOB {
            cbData: blob.len() as u32,
            pbData: blob.as_ptr() as *mut _,
        };
        let entropy = CRYPT_INTEGER_BLOB {
            cbData: ENTROPY.len() as u32,
            pbData: ENTROPY.as_ptr() as *mut _,
        };
        let mut out = CRYPT_INTEGER_BLOB { cbData: 0, pbData: std::ptr::null_mut() };
        if CryptUnprotectData(
            &input,
            std::ptr::null_mut(),
            &entropy,
            std::ptr::null(),
            std::ptr::null(),
            0,
            &mut out,
        ) == 0
        {
            return None;
        }
        let slice = std::slice::from_raw_parts(out.pbData, out.cbData as usize);
        let v = slice.to_vec();
        LocalFree(out.pbData as _);
        Some(v)
    }
}

#[cfg(test)]
mod tests {
    use super::{protect, unprotect};

    #[test]
    fn protect_roundtrip_on_this_platform() {
        let plain = "{\"api_key\":\"sk-secret\",\"note\":\"中文🎉\"}".as_bytes();
        let blob = protect(plain);
        assert_eq!(unprotect(&blob).as_deref(), Some(plain));
    }

    #[test]
    fn unprotect_rejects_garbage() {
        assert!(unprotect(&[]).is_none());
        assert!(unprotect(&[9]).is_none()); // 未知 tag
        assert!(unprotect(&[1, 1, 2, 3]).is_none()); // tag=1 但不是合法 DPAPI 密文
    }
}
