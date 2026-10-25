//! 课程详情组装：把一次 `print-data` 的 [`StudentTableVm`] 压成前端要的 [`CourseDetail`]。
//!
//! 单独成文件的理由：`guet.rs` 只管「怎么把数据从教务拿下来」，这里只管
//! 「怎么把它拼成人看的字段」。后者是**纯函数、零 IO**，可以脱离网络单测 ——
//! 教务字段漂移时（比如把 `stdCount` 挪走），坏的是这里而不是请求层，测试一眼能定位。
//!
//! 数据来源共有三处，缺一不可：
//! - `activities[]` —— 时段（时间 / 地点 / 周次 / 教师 / 课程类型 / 容量 / 学时构成）
//! - `arrangedLessonSearchVms[]` —— 教学班档案（考试类别 / 考试方式 / 课程属性 / 开课院系）
//! - 学生档案（`major` / `grade`）+ 学期名

use crate::error::{ReinError, Result};

use super::models::{
    ArrangedLessonSearchVm, CourseDetail, CoursePeriod, StudentTableVm, TimetableActivity,
};

/// 「大节节次」推导：教务的 1 大节 = 2 小节。
///
/// 1-2 节 → 1，3-4 节 → 2，5-6 节 → 3，7-8 节 → 4，9-10 节 → 5，11-12 节 → 6。
/// 用**起始小节**向上取整，与教务详情页逐字吻合（实测 3-4 节 → 2、6-7 节 → 3）。
///
/// 注意教务自己也返回 `startUnitName` / `endUnitName`，但**实测恒为 0**，
/// 拿它当大节会得到「所有课都在第 0 大节」——必须自己推。
pub fn big_section_of(start_unit: i64) -> i64 {
    if start_unit <= 0 {
        return 0;
    }
    (start_unit + 1) / 2
}

/// 从同一门课的若干时段里挑出用户点的那个。
///
/// 命中顺序：`(星期, 起始小节, 教学周)` → `(星期, 起始小节)` → 星期 → 第一个。
/// **第一个才是精确的那把钥匙**：一门课按周次段拆开、每段换教师换教室是常态
/// （桂电的健康教育四位老师轮着上），只按「星期 + 节次」命中的话，点第 6 周的格子
/// 会拿到第 12 周那条的教师 —— 课表格子与详情抽屉对不上，用户看到的就是「信息错了」。
///
/// 退路仍然保留：宁可给出「相近」的信息，也好过空手。
fn pick_activity(
    activities: &[TimetableActivity],
    weekday: Option<i64>,
    start_unit: Option<i64>,
    week: Option<i64>,
) -> Option<&TimetableActivity> {
    if activities.is_empty() {
        return None;
    }
    let slot = |a: &&TimetableActivity| {
        weekday.map_or(true, |w| a.weekday == Some(w))
            && start_unit.map_or(true, |u| a.start_unit == Some(u))
    };
    let in_week = |a: &&TimetableActivity| week.map_or(false, |w| a.week_indexes.contains(&w));
    if let Some(a) = activities.iter().filter(slot).find(|a| in_week(a)) {
        return Some(a);
    }
    if let Some(a) = activities.iter().find(slot) {
        return Some(a);
    }
    let by_day = activities
        .iter()
        .find(|a| weekday.map_or(true, |w| a.weekday == Some(w)));
    by_day.or_else(|| activities.first())
}

/// 找到与时段对应的教学班档案。
///
/// 两个键任一命中即可：教学班 id（`activity.lessonId` ↔ `arranged.id`）最准；
/// 它缺失时退回课号（`activity.lessonCode` ↔ `arranged.code`）。
fn find_arranged<'a>(
    arranged: &'a [ArrangedLessonSearchVm],
    activity: &TimetableActivity,
) -> Option<&'a ArrangedLessonSearchVm> {
    if let Some(id) = activity.lesson_id {
        if let Some(hit) = arranged.iter().find(|r| r.numeric_id() == Some(id)) {
            return Some(hit);
        }
    }
    let code = activity.lesson_code.as_deref()?;
    arranged.iter().find(|r| r.code.as_deref() == Some(code))
}

/// 把一门课的详情拼出来。
///
/// `lesson_id` 是全校统一的课程标识（就是 `activity.lessonId`）；`weekday` / `start_unit` /
/// `week` 用来在有多个时段时定位到具体那一个（`week` = 用户点的那一格属于第几教学周），
/// 传 `None` 就取该课的第一个时段。
pub fn build_course_detail(
    vm: &StudentTableVm,
    semester_name: &str,
    lesson_id: i64,
    weekday: Option<i64>,
    start_unit: Option<i64>,
    week: Option<i64>,
) -> Result<CourseDetail> {
    // 同一门课的全部时段（实验课一周可能分好几次上，地点还不同）
    let mine: Vec<&TimetableActivity> = vm
        .activities
        .iter()
        .filter(|a| a.lesson_id == Some(lesson_id))
        .collect();
    if mine.is_empty() {
        return Err(ReinError::Message(format!(
            "课表里找不到课程 {lesson_id} 的上课时段 —— 可能刚被退课或换了学期"
        )));
    }

    // `pick_activity` 要切片，这里借一次临时 Vec 的引用；生命周期只到本函数体内
    let owned: Vec<TimetableActivity> = mine.into_iter().cloned().collect();
    let activity = pick_activity(&owned, weekday, start_unit, week)
        .ok_or_else(|| ReinError::Message("课程详情组装失败：没有可用时段".into()))?;

    let arranged = find_arranged(&vm.arranged_lesson_search_vms, activity);

    let start_unit = activity.start_unit.unwrap_or(0);
    let mut weeks = activity.week_indexes.clone();
    weeks.sort_unstable();

    Ok(CourseDetail {
        course_name: activity
            .course_name
            .clone()
            .or_else(|| activity.lesson_name.clone())
            .unwrap_or_else(|| "未知课程".to_string()),
        course_code: activity.course_code.clone(),
        lesson_code: activity.lesson_code.clone(),
        lesson_name: activity.lesson_name.clone(),
        // 教务当前部署不返回课程说明（实测全文无 `description` 键），留空由前端显示「—」
        description: None,
        room: activity.room.clone(),
        room_alias: activity.building.clone(),
        campus: activity.campus.clone(),
        weekday: activity.weekday.unwrap_or(0),
        start_unit,
        end_unit: activity.end_unit.unwrap_or(0),
        start_time: activity.start_time.clone().unwrap_or_default(),
        end_time: activity.end_time.clone().unwrap_or_default(),
        big_section: big_section_of(start_unit),
        weeks_str: activity.weeks_str.clone(),
        start_week: weeks.first().copied(),
        end_week: weeks.last().copied(),
        teachers: activity.teachers.clone(),
        // 学分以时段上那份为准（教务详情页显示的也就是它）
        credits: activity.credits,
        course_type_code: activity
            .course_type
            .as_ref()
            .and_then(|t| t.code.clone())
            .or_else(|| {
                arranged
                    .and_then(|r| r.course_type.as_ref())
                    .and_then(|t| t.code.clone())
            }),
        course_type_name: activity
            .course_type
            .as_ref()
            .and_then(|t| t.name_zh.clone())
            .or_else(|| {
                arranged
                    .and_then(|r| r.course_type.as_ref())
                    .and_then(|t| t.name_zh.clone())
            }),
        exam_category: arranged
            .and_then(|r| r.exam_mode.as_ref())
            .and_then(|m| m.name_zh.clone()),
        exam_type: arranged.and_then(|r| r.arrange_exam_type_zh.clone()),
        course_property: arranged
            .and_then(|r| r.course_property.as_ref())
            .and_then(|p| p.name_zh.clone()),
        open_department: arranged
            .and_then(|r| r.open_department.as_ref())
            .and_then(|d| d.name_zh.clone()),
        major: vm.major.clone(),
        grade: vm.grade.clone(),
        semester_name: semester_name.to_string(),
        capacity: activity
            .limit_count
            .or_else(|| arranged.and_then(|r| r.limit_count)),
        enrolled: activity
            .std_count
            .or_else(|| arranged.and_then(|r| r.std_count)),
        has_experiment: arranged.is_some_and(ArrangedLessonSearchVm::has_experiment),
        // 实验批次：教务在时段上给 `groupNum`（合班/分组时才有），无则记 0
        experiment_batch: Some(activity.group_num.unwrap_or(0)),
        // 当前部署不返回「实验批次号 / 实验名称」，字段留着以免前端缺列
        experiment_batch_no: None,
        experiment_name: None,
        remark: activity
            .lesson_remark
            .clone()
            .or_else(|| arranged.and_then(|r| r.remark.clone())),
        period: activity
            .period_info
            .as_ref()
            .and_then(CoursePeriod::from_remote),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 大学英语1 的真实响应片段（2026-09 实测截取）—— 字段名逐字对齐教务。
    fn english_vm() -> StudentTableVm {
        let raw = serde_json::json!({
            "id": 241250,
            "code": "2600350118",
            "name": "李勇潮",
            "major": "智能科学与技术",
            "grade": "2026",
            "activities": [
                {
                    "lessonId": 319961,
                    "lessonCode": "2612316",
                    "lessonName": "2026信息安全26003301,26003302;2026智能科学与技术26003501",
                    "courseCode": "000011",
                    "courseName": "大学英语1",
                    "weeksStr": "3~18",
                    "weekIndexes": [3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18],
                    "room": "17204新",
                    "building": "花江校区第十七教学楼",
                    "campus": "花江校区",
                    "weekday": 3,
                    "startUnit": 3,
                    "endUnit": 4,
                    "startUnitName": 0,
                    "endUnitName": 0,
                    "lessonRemark": null,
                    "teachers": ["莫建萍"],
                    "courseType": { "nameZh": "通识必修", "code": "BG" },
                    "credits": 3,
                    "periodInfo": { "total": 48, "weeks": 0, "theory": 48 },
                    "stdCount": 51,
                    "limitCount": 52,
                    "startTime": "10:25",
                    "endTime": "12:00",
                    "groupNum": null
                }
            ],
            "arrangedLessonSearchVms": [
                {
                    "id": 319961,
                    "code": "2612316",
                    "nameZh": "大学英语1-1班",
                    "remark": null,
                    "stdCount": 51,
                    "limitCount": 52,
                    "arrangeExamTypeZh": "统一考试",
                    "examMode": { "nameZh": "考试", "code": "1" },
                    "courseType": { "nameZh": "通识必修", "code": "BG" },
                    "courseProperty": { "nameZh": "必修" },
                    "openDepartment": { "nameZh": "外国语学院" },
                    "actualTheoryPeriod": 48,
                    "actualPracticePeriod": 0,
                    "actualTestPeriod": 0,
                    "actualExperimentPeriod": 0,
                    "actualMachinePeriod": 0,
                    "actualDesignPeriod": 0,
                    "actualExtraPeriod": 0,
                    "expActualPeriods": 0,
                    "suggestScheduleWeeks": [3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18]
                }
            ]
        });
        serde_json::from_value(raw).expect("样本应能反序列化")
    }

    #[test]
    fn builds_detail_matching_the_official_page() {
        let vm = english_vm();
        let d = build_course_detail(&vm, "2026-2027上学期", 319961, Some(3), Some(3), None).unwrap();

        assert_eq!(d.course_name, "大学英语1");
        assert_eq!(d.lesson_code.as_deref(), Some("2612316"));
        assert_eq!(d.course_code.as_deref(), Some("000011"));
        assert_eq!(d.room.as_deref(), Some("17204新"));
        assert_eq!(d.room_alias.as_deref(), Some("花江校区第十七教学楼"));
        assert_eq!(d.start_time, "10:25");
        assert_eq!(d.end_time, "12:00");
        assert_eq!(d.start_unit, 3);
        assert_eq!(d.end_unit, 4);
        // 详情页「大节节次」= 2（3-4 小节 → 第 2 大节）
        assert_eq!(d.big_section, 2);
        assert_eq!(d.weekday, 3);
        assert_eq!(d.start_week, Some(3));
        assert_eq!(d.end_week, Some(18));
        assert_eq!(d.teachers, vec!["莫建萍".to_string()]);
        assert_eq!(d.course_type_code.as_deref(), Some("BG"));
        assert_eq!(d.course_type_name.as_deref(), Some("通识必修"));
        assert_eq!(d.exam_category.as_deref(), Some("考试"));
        assert_eq!(d.exam_type.as_deref(), Some("统一考试"));
        assert_eq!(d.course_property.as_deref(), Some("必修"));
        assert_eq!(d.open_department.as_deref(), Some("外国语学院"));
        assert_eq!(d.major.as_deref(), Some("智能科学与技术"));
        assert_eq!(d.grade.as_deref(), Some("2026"));
        assert_eq!(d.semester_name, "2026-2027上学期");
        assert_eq!(d.capacity, Some(52));
        assert_eq!(d.enrolled, Some(51));
        assert_eq!(d.credits, Some(3.0));
        assert!(!d.has_experiment);
        assert_eq!(d.experiment_batch, Some(0));
        assert!(d.description.is_none());
        // 学时构成搬运过来了
        assert_eq!(d.period.as_ref().and_then(|p| p.total), Some(48.0));
    }

    /// 同一门课一周两次（实验课常见），必须命中用户点的那个格子，而不是第一个。
    #[test]
    fn locates_the_exact_session_by_weekday_and_unit() {
        let raw = serde_json::json!({
            "major": "智能科学与技术",
            "activities": [
                { "lessonId": 7, "courseName": "物理实验", "weekday": 1, "startUnit": 1,
                  "endUnit": 2, "room": "A101", "weekIndexes": [1,2] },
                { "lessonId": 7, "courseName": "物理实验", "weekday": 5, "startUnit": 6,
                  "endUnit": 7, "room": "B202", "weekIndexes": [3,4] }
            ]
        });
        let vm: StudentTableVm = serde_json::from_value(raw).unwrap();

        let d = build_course_detail(&vm, "2026-2027上学期", 7, Some(5), Some(6), None).unwrap();
        assert_eq!(d.room.as_deref(), Some("B202"));
        assert_eq!(d.big_section, 3); // 6-7 节 → 第 3 大节
        assert_eq!(d.start_week, Some(3));
        assert_eq!(d.end_week, Some(4));

        // 只给星期也能定位
        let d = build_course_detail(&vm, "2026-2027上学期", 7, Some(1), None, None).unwrap();
        assert_eq!(d.room.as_deref(), Some("A101"));
        assert_eq!(d.big_section, 1);
    }

    /// 同一门课同一个格子，按**周次段**换教师换教室（桂电的健康教育四位老师轮着上）：
    /// 点第 6 周那一格要看黄观凤、点第 12 周要看马瑞杰 —— 只按星期/节次定位会一直给同一个。
    #[test]
    fn locates_the_exact_session_by_teaching_week() {
        let mut late = serde_json::json!({
            "lessonId": 322367, "courseName": "健康教育", "weekday": 4, "startUnit": 6,
            "endUnit": 7, "startTime": "14:30", "endTime": "16:05", "room": "17311*",
            "weekIndexes": [11, 12], "teachers": ["马瑞杰"]
        });
        let mut early = serde_json::json!({
            "lessonId": 322367, "courseName": "健康教育", "weekday": 4, "startUnit": 6,
            "endUnit": 7, "startTime": "14:30", "endTime": "16:05", "room": "17311*",
            "weekIndexes": [5, 6], "teachers": ["黄观凤"]
        });
        // 顺序刻意把「后段」放前面：老实现总取第一个匹配，正好会给出错的教师
        let vm: StudentTableVm = serde_json::from_value(serde_json::json!({
            "activities": [late.take(), early.take()]
        }))
        .unwrap();

        let d = build_course_detail(&vm, "2026-2027 第一学期", 322367, Some(4), Some(6), Some(6))
            .unwrap();
        assert_eq!(d.teachers, vec!["黄观凤".to_string()]);
        assert_eq!(d.start_week, Some(5));
        assert_eq!(d.end_week, Some(6));

        let d = build_course_detail(&vm, "2026-2027 第一学期", 322367, Some(4), Some(6), Some(12))
            .unwrap();
        assert_eq!(d.teachers, vec!["马瑞杰".to_string()]);

        // 给了一个不在任何周次段里的周次（比如学期末的空周）：退回按格子定位，不许空手
        let d = build_course_detail(&vm, "2026-2027 第一学期", 322367, Some(4), Some(6), Some(19))
            .unwrap();
        assert_eq!(d.course_name, "健康教育");
    }

    #[test]
    fn missing_lesson_is_an_error_not_a_blank_page() {
        let vm = english_vm();
        assert!(build_course_detail(&vm, "2026-2027上学期", 999999, None, None, None).is_err());
    }

    /// 实验课判定靠**实际学时**，不靠课程名 —— 独立设置的实验课看名字认不出来。
    #[test]
    fn experiment_flag_follows_actual_periods() {
        assert!(ArrangedLessonSearchVm {
            actual_experiment_period: Some(16.0),
            ..Default::default()
        }
        .has_experiment());
        assert!(ArrangedLessonSearchVm {
            actual_machine_period: Some(8.0),
            ..Default::default()
        }
        .has_experiment());
        // 纯理论课（既无实验也无上机学时）不是实验课
        assert!(!ArrangedLessonSearchVm::default().has_experiment());
    }

    #[test]
    fn big_section_table_matches_the_official_page() {
        // 1-2 → 1、3-4 → 2、5-6 → 3、7-8 → 4、9-10 → 5、11-12 → 6
        assert_eq!(big_section_of(1), 1);
        assert_eq!(big_section_of(2), 1);
        assert_eq!(big_section_of(3), 2);
        assert_eq!(big_section_of(4), 2);
        assert_eq!(big_section_of(6), 3);
        assert_eq!(big_section_of(7), 4);
        assert_eq!(big_section_of(12), 6);
        // 缺值时给 0 而不是 panic
        assert_eq!(big_section_of(0), 0);
    }
}
