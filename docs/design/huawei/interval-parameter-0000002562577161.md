# 间隔参数

间隔是 UI 设计中用于控制界面元素与元素、元素与容器之间空白距离的布局规范，用于定义界面的疏密关系、呼吸空间与视觉层次。

在视觉与体验上，合理的间隔能够塑造清晰有序的界面结构，核心作用包括梳理模块边界、避免视觉杂乱，引导自然顺畅的视觉流，明确信息阅读优先级，提升内容可读性与视觉舒适度。

通过统一间距数值规范，可以保证多页面、多组件风格高度一致，强化整体设计的秩序感与专业度，是构建规整、易用界面的基础布局属性。

## 间隔使用规则

**遵循统一栅格体系**：界面内所有间距优先使用固定基数的倍数（如 4vp、8vp 体系），避免随意数值，以保证全平台、全页面视觉统一。

**按照层级区分间距**：大小信息层级越高、独立性越强，间距越大；同级元素间距保持一致，上下级内容间距逐级区分，让视觉层次自然清晰。

**同类元素间距一致**：相同类型组件、相同场景的间距保持统一，如按钮组间距、列表间距、卡片间距等，减少用户认知负担。

**屏幕边缘间距固定**：规范界面内容与屏幕边缘、保留固定安全边距，避免内容贴边，提升握持与阅读舒适度，同时适配不同设备尺寸。

## 常用间隔类型

**屏幕边缘间隔**：指界面元素与屏幕四周边缘的留白距离，即外边距（margin），可结合产品定位与使用场景，统一调整界面整体留白尺度。

**元素间间隔**：指界面内各类视觉控件、功能组件、图标按钮、卡片模块等元素之间的留白距离，是平衡页面布局层级、区分功能模块、优化视觉节奏的核心基础规范。

**文本间间隔**：指界面内不同文本内容（如多行文字、功能说明文字、标题与正文等）之间的留白距离，合理设置可提升文字阅读舒适度与页面整洁度。

## 多设备屏幕边缘间隔尺寸

HarmonyOS 针对手机、平板、折叠设备、PC 等不同终端，分别定义标准化屏幕四边外边距（margin）数值，图例请参阅[系统安全区](https://developer.huawei.com/consumer/cn/doc/design-guides/design-layout-basics-0000001795579413#section167383215015)

|-------------|------|-------|------|-------|------|------|--------|--------|
|**间隔类型**|**手机**|**折叠屏**|**平板**|**智慧屏**|**穿戴**|**PC**|**智能座舱**|**场景**|
|屏幕边缘间隔/margin|16vp|24vp|32vp|48vp|26vp|40vp|48vp|屏幕左右两侧边距|
|屏幕边缘间隔/margin|36vp|36vp|36vp|27vp|20vp|/|/|屏幕顶部边距|
|屏幕边缘间隔/margin|28vp|28vp|28vp|27vp|20vp|/|/|屏幕底部边距|

## 多设备间隔使用场景示例

结合泛手机、智慧屏、穿戴设备等多类终端设备，抽取系统中常用的几个间隔，分别展示不同使用场景下的元素间间隔与文本间间隔应用示例，直观呈现跨设备间距规范的落地效果。

### 泛手机

**元素间间隔**

卡片之间的间隔，12vp。

控件间上下方向较大间隔，一般用于有明显边界元素间间隔，16vp。

控件间上下方向普通间隔，一般用于无明显边界元素间间隔，8vp。

控件间左右方向较大间隔，一般用于有明显边界元素间间隔，16vp。

控件间左右方向普通间隔，一般用于无明显边界元素间间隔，8vp。

|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
|![](https://contentcenter-vali-drcn.dbankcdn.cn/pvt_2/DeveloperAlliance_scene_100_1/c7/v3/PqbaFksTT3qvqT1-UK1nVA/zh-cn_image_0000002563879404.jpg?HW-CC-KV=V1&HW-CC-Date=20261008T154130Z&HW-CC-Expire=31536000000&HW-CC-Sign=4EA6470E5A4EA91BDAC1FEA7E00A1C1B52801886A8778B83E492182E25ED72F7 "点击放大")|![](https://contentcenter-vali-drcn.dbankcdn.cn/pvt_2/DeveloperAlliance_scene_100_1/bc/v3/4bDxmhELQvW7QcnVJ6NHTg/zh-cn_image_0000002594443231.jpg?HW-CC-KV=V1&HW-CC-Date=20261008T154130Z&HW-CC-Expire=31536000000&HW-CC-Sign=8380BE8F843774652171CDDC02653F63E20043A630B74F0ACB0F046ABB75B784 "点击放大")|
|卡片间间隔，12vp|控件间较大间隔，16vp|

**文本间间隔**

主次文本上下间隔 ，2vp。

主次文本左右间隔，8vp。

![](https://contentcenter-vali-drcn.dbankcdn.cn/pvt_2/DeveloperAlliance_scene_100_1/96/v3/PKK4naY2RU-KI3xVIRs7qA/zh-cn_image_0000002594373199.jpg?HW-CC-KV=V1&HW-CC-Date=20261008T154130Z&HW-CC-Expire=31536000000&HW-CC-Sign=D919D071AE60374D04A48D6F12D4C4852215D60E16DB4B41BC73D8F9B30572E1 "点击放大")

### 智慧屏

**元素间间隔**

控件间上下方向较大间隔，一般用于有明显边界元素间间隔 ，24vp。

控件间上下方向普通间隔，一般用于无明显边界元素间间隔，12vp。

控件间上下方向较小间隔，一般用于无明显边界元素间间隔，8vp。

控件间左右方向较大间隔，一般用于有明显边界元素间间隔，24vp。

控件间左右方向普通间隔，一般用于无明显边界元素间间隔，12vp。

|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
|![](https://contentcenter-vali-drcn.dbankcdn.cn/pvt_2/DeveloperAlliance_scene_100_1/25/v3/44yUklndRyme8u5EHdY42A/zh-cn_image_0000002593924215.png?HW-CC-KV=V1&HW-CC-Date=20261008T154130Z&HW-CC-Expire=31536000000&HW-CC-Sign=7D5DF00B11F42DA82D845206646E18B9271EEF13DD9DCE49787974015E540642 "点击放大")|![](https://contentcenter-vali-drcn.dbankcdn.cn/pvt_2/DeveloperAlliance_scene_100_1/5b/v3/QROFwlaKTmOR-VJ2G3gZ9Q/zh-cn_image_0000002593924241.png?HW-CC-KV=V1&HW-CC-Date=20261008T154130Z&HW-CC-Expire=31536000000&HW-CC-Sign=AED5FAF326AEA8FD2C056742AAD65F94BBD7DFB3A9D03FD7BEF2CABD4F349090 "点击放大")|
|控件间上下间隔|控件间左右间隔|

**文本间间隔**

第一层级文本段落间隔，32vp。

第二层级文本段落间隔，24vp。

第三层级文本段落间隔，16vp。

第四层级文本段落间隔，8vp。

第五层级文本段落间隔，4vp。

![](https://contentcenter-vali-drcn.dbankcdn.cn/pvt_2/DeveloperAlliance_scene_100_1/6a/v3/ZkKQQqqgSaOXLyH3X-_TmQ/zh-cn_image_0000002563491542.jpg?HW-CC-KV=V1&HW-CC-Date=20261008T154130Z&HW-CC-Expire=31536000000&HW-CC-Sign=C799AD30D019B2AE8EA4AC9696E7257F4C48E856C44DAC56A318E12F1CCDB06C "点击放大")

### 穿戴

**元素间间隔**

|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
|![](https://contentcenter-vali-drcn.dbankcdn.cn/pvt_2/DeveloperAlliance_scene_100_1/13/v3/P_eBMlGKRiep5uwa2csY6w/zh-cn_image_0000002563331520.png?HW-CC-KV=V1&HW-CC-Date=20261008T154130Z&HW-CC-Expire=31536000000&HW-CC-Sign=BC95970E3A7C21E461B33C5FE935A3C2EA75ED290D2697C8BD8294D8B998687E "点击放大")|![](https://contentcenter-vali-drcn.dbankcdn.cn/pvt_2/DeveloperAlliance_scene_100_1/7b/v3/HTh_q8oxRTuvupI5ZteIqQ/zh-cn_image_0000002593970917.png?HW-CC-KV=V1&HW-CC-Date=20261008T154130Z&HW-CC-Expire=31536000000&HW-CC-Sign=D9484E6B58620932BA04B7CC8B36785EAA2E9B36A7407F362DDB7A0E32E5B544 "点击放大")|
|间距 9（12vp）|间距 9（12vp）|
|![](https://contentcenter-vali-drcn.dbankcdn.cn/pvt_2/DeveloperAlliance_scene_100_1/c1/v3/cPDuvhM8Q4m-PHZnVTR_UA/zh-cn_image_0000002563491172.png?HW-CC-KV=V1&HW-CC-Date=20261008T154130Z&HW-CC-Expire=31536000000&HW-CC-Sign=90ACADEC79921270CA18C7E34AECD97DB379A9A7B828924368BCD90FE62E3907 "点击放大")|![](https://contentcenter-vali-drcn.dbankcdn.cn/pvt_2/DeveloperAlliance_scene_100_1/a0/v3/0-7gog3uQBuWFjV7TVb2RA/zh-cn_image_0000002593930873.png?HW-CC-KV=V1&HW-CC-Date=20261008T154130Z&HW-CC-Expire=31536000000&HW-CC-Sign=EF288944175BA340820FBC006F74218A8C92187A39BAB7E9BB3F6E56691B128D "点击放大")|
|间距10（6vp）|间距 10（6vp）|
|![](https://contentcenter-vali-drcn.dbankcdn.cn/pvt_2/DeveloperAlliance_scene_100_1/bb/v3/1OPTZmNRSxyRvCGvCzD4vw/zh-cn_image_0000002563331522.png?HW-CC-KV=V1&HW-CC-Date=20261008T154130Z&HW-CC-Expire=31536000000&HW-CC-Sign=4814F611B08AC572989C99832E5C9CE55F9E7172A7FC729DA85DFCE17E76F570 "点击放大")|![](https://contentcenter-vali-drcn.dbankcdn.cn/pvt_2/DeveloperAlliance_scene_100_1/c0/v3/nXH72-j6SaykHxts2Ht-5w/zh-cn_image_0000002593970919.png?HW-CC-KV=V1&HW-CC-Date=20261008T154130Z&HW-CC-Expire=31536000000&HW-CC-Sign=6974379B7928925A33C5966AC9DF0482CB75358A23019ED305063AE9B9D28A20 "点击放大")|
|间距 11（8vp）|间距 12（26vp）|

**文本间间隔**

|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
|![](https://contentcenter-vali-drcn.dbankcdn.cn/pvt_2/DeveloperAlliance_scene_100_1/a9/v3/lyCv_TR4SNq_arzdZZF6yw/zh-cn_image_0000002563326264.png?HW-CC-KV=V1&HW-CC-Date=20261008T154130Z&HW-CC-Expire=31536000000&HW-CC-Sign=92CFC92D6F661A32A24866EA2E88B409BA6C802B45B37CA5B527F6573452EA1B "点击放大")|![](https://contentcenter-vali-drcn.dbankcdn.cn/pvt_2/DeveloperAlliance_scene_100_1/c7/v3/V4KvlhAsRDWetU3QenXyzA/zh-cn_image_0000002563326372.png?HW-CC-KV=V1&HW-CC-Date=20261008T154130Z&HW-CC-Expire=31536000000&HW-CC-Sign=67D9313DCBEBFE461FAD40014BDF2A06FCB46E6F02B994AD0D52200CD404CB65 "点击放大")|
|间距 13（16vp），间距 15（6vp）|间距 14（12vp）|
|![](https://contentcenter-vali-drcn.dbankcdn.cn/pvt_2/DeveloperAlliance_scene_100_1/63/v3/utOqE_szTHqLAQh0cg9pBA/zh-cn_image_0000002563486740.png?HW-CC-KV=V1&HW-CC-Date=20261008T154130Z&HW-CC-Expire=31536000000&HW-CC-Sign=054B09BADCC3E56A954C06C8F3C38F0771816A968CE8F0FAB2748A006866A129 "点击放大")|![](https://contentcenter-vali-drcn.dbankcdn.cn/pvt_2/DeveloperAlliance_scene_100_1/43/v3/OoJSxYR-Tfy6LfaSUwGRkA/zh-cn_image_0000002593926533.png?HW-CC-KV=V1&HW-CC-Date=20261008T154130Z&HW-CC-Expire=31536000000&HW-CC-Sign=1A849DF513C7D0162EC28A68C71B917A5690E584FC759EE6A2A632FE2483D744 "点击放大")|
|间距 16（2vp）|间距 17（2vp）|

## 系统间隔Token全量表

|---------------|------|
|**Token**|**数值**|
|Padding_level0|0|
|Padding_level1|2|
|Padding_level2|4|
|Padding_level3|6|
|Padding_level4|8|
|Padding_level5|10|
|Padding_level6|12|
|Padding_level7|14|
|Padding_level8|16|
|Padding_level9|18|
|Padding_level10|20|
|Padding_level11|22|
|Padding_level12|24|
|Padding_level13|26|
|Padding_level16|32|
|Padding_level17|34|
|Padding_level18|36|
|Padding_level19|38|
|Padding_level20|40|
|Padding_level21|42|
|Padding_level22|44|
|Padding_level23|46|
|Padding_level25|50|
|Padding_level26|52|
|Padding_level27|54|
|Padding_level28|56|
|Padding_level29|58|
|Padding_level30|60|
|Padding_level32|64|
|Padding_level33|66|
|Padding_level34|68|
|Padding_level35|70|
|Padding_level36|72|

