//! 心率区间与运动消耗估算（纯函数 + 测量会话累加器）。
//!
//! 热量用 Keytel 等人（2005）的心率—能量回归，按相邻样本做梯形积分：
//!   kJ/min = -55.0969 + 0.6309·HR + 0.1988·体重 + 0.2017·年龄     （男）
//!   kJ/min = -20.4022 + 0.4472·HR - 0.1263·体重 + 0.074·年龄      （女）
//!   kcal/min = kJ/min ÷ 4.184
//! 性别未知时取两式均值。心率过低时公式会给出负值，按 0 处理；上限 25 kcal/min
//! 防止异常读数把整场热量带飞。积分只在相邻样本间隔 ≤ 10s 时进行，蓝牙断开
//! 的整段空档既不计热量也不计入覆盖率 —— 那段时间没有“按心率消耗”的依据。
//!
//! 积分喂的是样本的 EMA 平滑值（时间常数约 10 秒）：手环的光学读数有瞬时毛刺，
//! 而 Keytel 假设稳态，尖峰样本不该直接进入热量积分。
//!
//! 区间沿用 5 分区，最大心率按 Tanaka（2001）`208 − 0.7×年龄`、女性按 Gulati
//! （2010）`206 − 0.88×年龄`（性别未知时用 Tanaka，两式都无需性别）。注意这与
//! `modules/healthsync` 的 220 − 年龄是两套口径 —— healthsync 是静态资料口径，
//! 这里是有实时测量的运动场景，Tanaka/Gulati 的个体残差更小。
//!   <60% 热身 / 60–70% 燃脂 / 70–80% 有氧 / 80–90% 无氧 / ≥90% 极限。
//! 强度反推：<65% low / 65–80% moderate / ≥80% high。

use super::models::{HrWorkoutSummary, HrZoneTime};

/// 相邻样本间隔超过它就视为断档：不积分、不计覆盖率。
const MAX_GAP_SEC: f64 = 10.0;
const KCAL_PER_MIN_CAP: f64 = 25.0;
/// 年龄缺失时用于强度反推的兜底最大心率（等价 Tanaka 30 岁）。区间仍保持 null。
const FALLBACK_MAX_HR: f64 = 187.0;
/// 样本 EMA 系数（约 1 Hz 采样，时间常数 ≈ 10 秒）：压光学读数毛刺，不明显拖慢响应。
const EMA_ALPHA: f64 = 0.1;

#[derive(Debug, Clone, Default)]
pub struct HrProfile {
    pub age_years: Option<f64>,
    pub sex: Option<String>,
    pub weight_kg: Option<f64>,
}

impl HrProfile {
    pub fn new(age_years: Option<f64>, sex: Option<String>, weight_kg: Option<f64>) -> Self {
        Self {
            age_years: age_years.filter(|a| a.is_finite()),
            sex: sex.filter(|s| s == "male" || s == "female"),
            weight_kg: weight_kg.filter(|w| w.is_finite()),
        }
    }

    fn age(&self) -> f64 {
        self.age_years.unwrap_or(30.0).clamp(10.0, 100.0)
    }

    fn weight(&self) -> f64 {
        self.weight_kg.unwrap_or(70.0).clamp(25.0, 300.0)
    }

    /// 估算最大心率：Tanaka（2001）`208 − 0.7×年龄`，女性 Gulati（2010）
    /// `206 − 0.88×年龄`。年龄未填时为 None（UI 不显示区间，但仍可用兜底值反推强度）。
    pub fn max_hr(&self) -> Option<u16> {
        self.age_years.map(|a| {
            let m = match self.sex.as_deref() {
                Some("female") => 206.0 - 0.88 * a,
                _ => 208.0 - 0.7 * a,
            };
            m.clamp(120.0, 210.0).round() as u16
        })
    }

    pub fn zone_of(&self, bpm: u16) -> Option<u8> {
        self.max_hr().map(|m| zone_of_ratio(f64::from(bpm) / f64::from(m)))
    }

    /// 平均心率用于强度档（百分比对缺失年龄用兜底值，保证手工记录也有档位）。
    pub fn intensity_of(&self, bpm: u16) -> String {
        let max = self.max_hr().map_or(FALLBACK_MAX_HR, f64::from);
        intensity_of_ratio(f64::from(bpm) / max).to_string()
    }

    /// Keytel 心率—能量回归（kcal/min），已做非负与上限裁剪。
    pub fn kcal_per_minute(&self, bpm: f64) -> f64 {
        let age = self.age();
        let weight = self.weight();
        let male = -55.0969 + 0.6309 * bpm + 0.1988 * weight + 0.2017 * age;
        let female = -20.4022 + 0.4472 * bpm - 0.1263 * weight + 0.074 * age;
        let kj = match self.sex.as_deref() {
            Some("male") => male,
            Some("female") => female,
            _ => (male + female) / 2.0,
        };
        (kj / 4.184).clamp(0.0, KCAL_PER_MIN_CAP)
    }
}

pub fn zone_of_ratio(ratio: f64) -> u8 {
    if ratio < 0.6 {
        1
    } else if ratio < 0.7 {
        2
    } else if ratio < 0.8 {
        3
    } else if ratio < 0.9 {
        4
    } else {
        5
    }
}

pub fn intensity_of_ratio(ratio: f64) -> &'static str {
    if ratio < 0.65 {
        "low"
    } else if ratio < 0.80 {
        "moderate"
    } else {
        "high"
    }
}

/// 一场测量会话的累加器。样本只保留最后一个（积分是流式的，不需要整段历史），
/// 内存占用与训练时长无关。
#[derive(Debug, Clone)]
pub(crate) struct Measurement {
    started_ms: i64,
    profile: HrProfile,
    samples: u32,
    last: Option<(f64, f64)>,
    /// 最近一条样本的 EMA 平滑值：热量 / 均值 / 区间积分都吃它，原始读数只用于极值
    ema: Option<f64>,
    measured_sec: f64,
    bpm_sec_sum: f64,
    kcal: f64,
    zone_sec: [f64; 5],
    max_bpm: u16,
    min_bpm: u16,
    /// 暂停累计毫秒（跑步暂停 / 自动暂停 / 已结束待保存）
    paused_ms: i64,
    /// 当前暂停的起点；None = 正在测量
    paused_at: Option<i64>,
}

impl Measurement {
    pub fn new(started_ms: i64, profile: HrProfile) -> Self {
        Self {
            started_ms,
            profile,
            samples: 0,
            last: None,
            ema: None,
            measured_sec: 0.0,
            bpm_sec_sum: 0.0,
            kcal: 0.0,
            zone_sec: [0.0; 5],
            max_bpm: 0,
            min_bpm: 0,
            paused_ms: 0,
            paused_at: None,
        }
    }

    /// 暂停 / 恢复积分。暂停期间的样本不参与热量、均值与覆盖率；恢复时清掉上一个
    /// 积分锚点，跨过暂停的那段间隔不会被当成一次超长采样间隔补算。
    pub fn set_paused(&mut self, paused: bool, at_ms: i64) {
        if paused {
            if self.paused_at.is_none() {
                self.paused_at = Some(at_ms);
                self.last = None;
            }
        } else if let Some(start) = self.paused_at.take() {
            self.paused_ms += (at_ms - start).max(0);
        }
    }

    fn active_elapsed_sec(&self, at_ms: i64) -> f64 {
        let paused_now = self.paused_at.map_or(0, |start| (at_ms - start).max(0));
        ((at_ms - self.started_ms - self.paused_ms - paused_now).max(0) as f64) / 1000.0
    }

    pub fn profile(&self) -> &HrProfile {
        &self.profile
    }

    pub fn started_ms(&self) -> i64 {
        self.started_ms
    }

    pub fn set_profile(&mut self, profile: HrProfile) {
        self.profile = profile;
    }

    /// 喂入一条样本。dt 取相邻样本的实际间隔，所以 UI 事件丢帧不会影响积分。
    /// 热量 / 均值 / 区间用 EMA 平滑后的心率，极值（max/min）保留原始读数。
    pub fn push(&mut self, at_ms: i64, bpm: u16) {
        if bpm == 0 || bpm > 250 || self.paused_at.is_some() {
            return;
        }
        let elapsed = self.active_elapsed_sec(at_ms);
        self.max_bpm = self.max_bpm.max(bpm);
        self.min_bpm = if self.samples == 0 { bpm } else { self.min_bpm.min(bpm) };
        let ema = match self.ema {
            Some(e) => e + EMA_ALPHA * (f64::from(bpm) - e),
            None => f64::from(bpm),
        };
        if let Some((prev_t, prev_ema)) = self.last {
            let dt = elapsed - prev_t;
            if dt > 0.0 && dt <= MAX_GAP_SEC {
                let avg = (prev_ema + ema) / 2.0;
                self.kcal += self.profile.kcal_per_minute(avg) * dt / 60.0;
                self.measured_sec += dt;
                self.bpm_sec_sum += avg * dt;
                if let Some(zone) = self.profile.zone_of(avg.round() as u16) {
                    self.zone_sec[usize::from(zone - 1)] += dt;
                }
            }
        }
        self.last = Some((elapsed, ema));
        self.ema = Some(ema);
        self.samples += 1;
    }

    pub fn samples(&self) -> u32 {
        self.samples
    }

    pub fn elapsed_sec(&self, now_ms: i64) -> u32 {
        self.active_elapsed_sec(now_ms).max(0.0) as u32
    }

    pub fn measured_sec(&self) -> u32 {
        self.measured_sec.round() as u32
    }

    pub fn avg_bpm(&self) -> Option<u16> {
        if self.measured_sec > 0.5 {
            Some((self.bpm_sec_sum / self.measured_sec).round() as u16)
        } else {
            None
        }
    }

    pub fn max_bpm(&self) -> Option<u16> {
        (self.samples > 0).then_some(self.max_bpm)
    }

    pub fn kcal(&self) -> Option<f64> {
        (self.samples > 0).then_some((self.kcal * 10.0).round() / 10.0)
    }

    pub fn coverage(&self, now_ms: i64) -> f64 {
        let total = f64::from(self.elapsed_sec(now_ms)).max(1.0);
        (self.measured_sec / total).clamp(0.0, 1.0)
    }

    pub fn level(&self) -> Option<u8> {
        self.avg_bpm().and_then(|bpm| self.profile.zone_of(bpm))
    }

    pub fn summary(&self, now_ms: i64) -> Option<HrWorkoutSummary> {
        if self.samples == 0 {
            return None;
        }
        let avg = self.avg_bpm();
        let zones = self
            .zone_sec
            .iter()
            .enumerate()
            .filter(|(_, secs)| **secs >= 0.5)
            .map(|(i, secs)| HrZoneTime {
                zone: (i + 1) as u8,
                seconds: secs.round() as u32,
            })
            .collect();
        Some(HrWorkoutSummary {
            duration_sec: self.elapsed_sec(now_ms),
            measured_sec: self.measured_sec(),
            coverage: self.coverage(now_ms),
            samples: self.samples(),
            avg_bpm: avg,
            max_bpm: self.max_bpm(),
            min_bpm: (self.samples() > 0).then_some(self.min_bpm),
            kcal: self.kcal(),
            zones,
            level: self.level(),
            intensity: avg.map(|bpm| self.profile.intensity_of(bpm)),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn male_profile() -> HrProfile {
        HrProfile::new(Some(30.0), Some("male".into()), Some(70.0))
    }

    #[test]
    fn keytel_male_rate_is_in_expected_range() {
        let rate = male_profile().kcal_per_minute(150.0);
        // 理论值 14.22 kcal/min
        assert!((rate - 14.22).abs() < 0.05, "rate = {rate}");
    }

    #[test]
    fn unknown_sex_averages_the_two_equations() {
        let male = HrProfile::new(Some(30.0), Some("male".into()), Some(70.0));
        let female = HrProfile::new(Some(30.0), Some("female".into()), Some(70.0));
        let unknown = HrProfile::new(Some(30.0), None, Some(70.0));
        let avg = (male.kcal_per_minute(140.0) + female.kcal_per_minute(140.0)) / 2.0;
        assert!((unknown.kcal_per_minute(140.0) - avg).abs() < 0.001);
    }

    #[test]
    fn max_hr_follows_tanaka_and_gulati() {
        let male = HrProfile::new(Some(30.0), Some("male".into()), Some(70.0));
        assert_eq!(male.max_hr(), Some(187)); // 208 − 0.7×30
        let female = HrProfile::new(Some(30.0), Some("female".into()), Some(70.0));
        assert_eq!(female.max_hr(), Some(180)); // 206 − 0.88×30
        let unknown = HrProfile::new(Some(30.0), None, Some(70.0));
        assert_eq!(unknown.max_hr(), Some(187)); // 性别未知退 Tanaka
        // 50 岁：Tanaka 173、Gulati 162 —— 差异必须体现在区间与强度反推上
        let m50 = HrProfile::new(Some(50.0), Some("male".into()), None);
        assert_eq!(m50.max_hr(), Some(173));
        let f50 = HrProfile::new(Some(50.0), Some("female".into()), None);
        assert_eq!(f50.max_hr(), Some(162));
    }

    #[test]
    fn zone_boundaries_follow_five_zone_model() {
        let p = male_profile(); // max hr 187（Tanaka 30 岁）
        assert_eq!(p.zone_of(100), Some(1)); // 53.5%
        assert_eq!(p.zone_of(120), Some(2)); // 64.2%
        assert_eq!(p.zone_of(140), Some(3)); // 74.9%
        assert_eq!(p.zone_of(160), Some(4)); // 85.6%
        assert_eq!(p.zone_of(180), Some(5)); // 96.3%
    }

    #[test]
    fn integration_over_one_minute_matches_rate() {
        let mut m = Measurement::new(0, male_profile());
        // 手环实际约 1 Hz：按 5 秒一条喂满一分钟（超过 10 秒的间隔会被当作断档）
        for t in (0..=60_000).step_by(5_000) {
            m.push(t, 150);
        }
        assert!((m.kcal().unwrap_or_default() - 14.2).abs() < 0.05);
        assert_eq!(m.measured_sec(), 60);
        assert_eq!(m.avg_bpm(), Some(150));
    }

    #[test]
    fn gaps_longer_than_ten_seconds_are_not_counted() {
        let mut m = Measurement::new(0, male_profile());
        m.push(0, 150);
        m.push(30_000, 150);
        assert_eq!(m.measured_sec(), 0);
        assert_eq!(m.kcal(), Some(0.0));
        assert_eq!(m.avg_bpm(), None);
    }

    #[test]
    fn summary_reports_coverage_and_intensity() {
        let mut m = Measurement::new(0, male_profile());
        for t in (0..=30_000).step_by(5_000) {
            m.push(t, 90);
        }
        let s = m.summary(60_000).expect("summary");
        assert_eq!(s.duration_sec, 60);
        assert_eq!(s.measured_sec, 30);
        assert!((s.coverage - 0.5).abs() < 0.001);
        assert_eq!(s.intensity.as_deref(), Some("low"));
        assert_eq!(s.level, Some(1));
    }

    #[test]
    fn invalid_samples_are_ignored() {
        let mut m = Measurement::new(0, male_profile());
        m.push(0, 0);
        m.push(1_000, 251);
        assert_eq!(m.samples(), 0);
        assert!(m.summary(10_000).is_none());
    }

    #[test]
    fn spike_samples_are_smoothed_into_integration() {
        let mut base = Measurement::new(0, male_profile());
        let mut spiky = Measurement::new(0, male_profile());
        for t in (0..=60_000).step_by(5_000) {
            base.push(t, 150);
            // 一条 250 的毛刺样本：EMA 把它摊开，对整分钟热量的污染有限
            let bpm = if t == 30_000 { 250 } else { 150 };
            spiky.push(t, bpm);
        }
        let diff = spiky.kcal().unwrap_or_default() - base.kcal().unwrap_or_default();
        assert!(diff > 0.0 && diff < 1.5, "spike delta = {diff}");
        // 极值仍保留原始读数：毛刺计入 max，平滑不吞掉真实峰值
        assert_eq!(spiky.max_bpm(), Some(250));
        assert_eq!(base.max_bpm(), Some(150));
    }

    #[test]
    fn paused_samples_are_excluded_from_kcal_and_duration() {
        let mut m = Measurement::new(0, male_profile());
        for t in (0..=30_000).step_by(5_000) {
            m.push(t, 150);
        }
        assert_eq!(m.measured_sec(), 30);

        m.set_paused(true, 30_000);
        m.push(40_000, 150); // 暂停期间：忽略
        assert_eq!(m.measured_sec(), 30);

        m.set_paused(false, 70_000); // 暂停了 40 秒
        m.push(70_000, 150); // 恢复后第一条只作锚点
        for t in (75_000..=100_000).step_by(5_000) {
            m.push(t, 150);
        }
        assert_eq!(m.elapsed_sec(100_000), 60);
        assert_eq!(m.measured_sec(), 60);

        let summary = m.summary(100_000).expect("summary");
        assert!((summary.coverage - 1.0).abs() < 0.01);
    }
}
