//! 蓝牙标准心率测量特征（0x2A37）解码。
//!
//! 格式依据 GATT 规范：首字节是 flags，
//! - bit0：心率值是 u16 little-endian（否则 u8）；
//! - bit1：传感器接触状态（仅 bit2=1 时有意义）；
//! - bit2：设备支持接触检测；
//! - bit3：后续有 2 字节能量消耗（kJ）；
//! - bit4：后续是若干 2 字节 RR 间期（单位 1/1024 秒）。
//!
//! 越界一律返回 None：手环固件偶尔会发半包，宁可丢一拍也不要 panic。

const FLAG_U16: u8 = 0x01;
const FLAG_CONTACT: u8 = 0x02;
const FLAG_CONTACT_SUPPORTED: u8 = 0x04;
const FLAG_ENERGY: u8 = 0x08;
const FLAG_RR: u8 = 0x10;

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct HrMeasurement {
    pub bpm: u16,
    pub contact: Option<bool>,
    pub energy_kj: Option<u16>,
    pub rr_ms: Vec<u16>,
}

pub(crate) fn parse_measurement(data: &[u8]) -> Option<HrMeasurement> {
    let flags = *data.first()?;
    let mut i = 1usize;

    let bpm = if flags & FLAG_U16 != 0 {
        let raw = data.get(i..i + 2)?;
        i += 2;
        u16::from_le_bytes([raw[0], raw[1]])
    } else {
        let raw = *data.get(i)?;
        i += 1;
        u16::from(raw)
    };

    // 0 bpm 没有意义（多为未佩戴 / 固件占位），按无效包丢弃
    if bpm == 0 || bpm > 250 {
        return None;
    }

    let contact = if flags & FLAG_CONTACT_SUPPORTED != 0 {
        Some(flags & FLAG_CONTACT != 0)
    } else {
        None
    };

    let energy_kj = if flags & FLAG_ENERGY != 0 {
        let raw = data.get(i..i + 2)?;
        i += 2;
        Some(u16::from_le_bytes([raw[0], raw[1]]))
    } else {
        None
    };

    let mut rr_ms = Vec::new();
    if flags & FLAG_RR != 0 {
        while let Some(raw) = data.get(i..i + 2) {
            let raw16 = u16::from_le_bytes([raw[0], raw[1]]);
            // 1/1024 秒 → 毫秒
            rr_ms.push(((u32::from(raw16) * 1000 + 512) / 1024) as u16);
            i += 2;
        }
        // 规范要求 RR 成对出现；落单的字节当作没有 RR，不报错
    }

    Some(HrMeasurement {
        bpm,
        contact,
        energy_kj,
        rr_ms,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_u8_bpm_with_contact() {
        let m = parse_measurement(&[0x06, 72]).expect("valid");
        assert_eq!(m.bpm, 72);
        assert_eq!(m.contact, Some(true));
        assert_eq!(m.energy_kj, None);
        assert!(m.rr_ms.is_empty());
    }

    #[test]
    fn contact_absent_when_not_supported() {
        let m = parse_measurement(&[0x00, 88]).expect("valid");
        assert_eq!(m.contact, None);
    }

    #[test]
    fn parses_16_bit_bpm_and_rr() {
        // flags = u16 | RR；bpm = 0x00A6 = 166；两条 RR = 1024/1024 → 1000ms
        let data = [0x11, 0xA6, 0x00, 0x00, 0x04, 0x00, 0x04];
        let m = parse_measurement(&data).expect("valid");
        assert_eq!(m.bpm, 166);
        assert_eq!(m.rr_ms, vec![1000, 1000]);
    }

    #[test]
    fn rejects_zero_and_out_of_range() {
        assert!(parse_measurement(&[0x00, 0]).is_none());
        assert!(parse_measurement(&[0x00, 251]).is_none());
        assert!(parse_measurement(&[]).is_none());
    }

    #[test]
    fn rejects_truncated_packets() {
        assert!(parse_measurement(&[0x01]).is_none());
        assert!(parse_measurement(&[0x01, 0x50]).is_none());
        assert!(parse_measurement(&[0x08, 0x50]).is_none());
    }
}
