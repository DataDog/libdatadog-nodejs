use napi::{Env, JsFunction, JsObject, JsUnknown};
use napi_derive::napi;

fn get_optional_string_property(obj: &JsObject, key: &str) -> napi::Result<Option<String>> {
    match obj.get_named_property::<JsUnknown>(key) {
        Ok(val) => {
            use napi::ValueType;
            if val.get_type()? == ValueType::String {
                let s: String = val.coerce_to_string()?.into_utf8()?.as_str()?.to_owned();
                if s.is_empty() {
                    Ok(None)
                } else {
                    Ok(Some(s))
                }
            } else {
                Ok(None)
            }
        }
        Err(_) => Ok(None),
    }
}

fn parse_v8_stack(stack: &str) -> libdd_crashtracker::StackTrace {
    let mut frames = Vec::new();

    for line in stack.lines().skip(1) {
        let line = line.trim();
        let line = match line.strip_prefix("at ") {
            Some(rest) => rest,
            None => continue,
        };

        let mut frame = libdd_crashtracker::StackFrame::new();

        // Formats:
        //   "functionName (file:line:col)"
        //   "functionName (file:line)"
        //   "file:line:col"
        //   "file:line"
        if let Some(paren_start) = line.rfind('(') {
            let func_name = line[..paren_start].trim();
            if !func_name.is_empty() {
                frame.function = Some(func_name.to_string());
            }
            let location = line[paren_start + 1..].trim_end_matches(')');
            parse_location(location, &mut frame);
        } else {
            parse_location(line, &mut frame);
        }

        frames.push(frame);
    }

    libdd_crashtracker::StackTrace::from_frames(frames, false)
}

fn parse_location(location: &str, frame: &mut libdd_crashtracker::StackFrame) {
    // location is "file:line:col" or "file:line" or just "native" etc.
    // The file portion may contain ":" ("node:internal/...")
    // so we split from the right.
    let parts: Vec<&str> = location.rsplitn(3, ':').collect();
    match parts.len() {
        3 => {
            // col, line, file
            frame.column = parts[0].parse().ok();
            frame.line = parts[1].parse().ok();
            frame.file = Some(parts[2].to_string());
        }
        2 => {
            if let Ok(line_num) = parts[0].parse::<u32>() {
                frame.line = Some(line_num);
                frame.file = Some(parts[1].to_string());
            } else {
                frame.file = Some(location.to_string());
            }
        }
        _ => {
            frame.file = Some(location.to_string());
        }
    }
}

fn is_error_instance(env: &Env, value: &JsUnknown) -> napi::Result<bool> {
    let global = env.get_global()?;
    let error_ctor: JsFunction = global.get_named_property("Error")?;
    value.instanceof(error_ctor)
}

fn stringify_js_value(value: JsUnknown) -> napi::Result<String> {
    let s = value.coerce_to_string()?.into_utf8()?;
    Ok(s.as_str()?.to_owned())
}

fn report_unhandled(env: &Env, error: JsUnknown, fallback_type: &str) -> napi::Result<()> {
    let is_error = is_error_instance(env, &error)?;
    let (exception_type, exception_message, stacktrace) = if is_error {
        let error_obj: JsObject = error.coerce_to_object()?;
        let name = get_optional_string_property(&error_obj, "name")?;
        let message = get_optional_string_property(&error_obj, "message")?;
        let stack_string = get_optional_string_property(&error_obj, "stack")?;
        let stacktrace = match &stack_string {
            Some(s) => parse_v8_stack(s),
            None => libdd_crashtracker::StackTrace::new_incomplete(),
        };
        (name, message, stacktrace)
    } else {
        let message = stringify_js_value(error).ok();
        (
            Some(fallback_type.to_string()),
            message,
            // libdatadog defines a missing stacktrace as incomplete
            libdd_crashtracker::StackTrace::new_incomplete(),
        )
    };

    libdd_crashtracker::report_unhandled_exception(
        exception_type.as_deref(),
        exception_message.as_deref(),
        stacktrace,
    )
    .unwrap();

    Ok(())
}

#[napi]
pub fn report_uncaught_exception(env: Env, error: JsUnknown) -> napi::Result<()> {
    report_unhandled(&env, error, "uncaughtException")
}

#[napi]
pub fn report_unhandled_rejection(env: Env, error: JsUnknown) -> napi::Result<()> {
    report_unhandled(&env, error, "unhandledRejection")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_v8_stack_typical_error() {
        let stack = "\
TypeError: Cannot read properties of undefined (reading 'foo')
    at Object.method (/app/src/index.js:10:15)
    at Module._compile (node:internal/modules/cjs/loader:1234:14)
    at /app/src/helper.js:5:3";

        let trace = parse_v8_stack(stack);
        assert_eq!(trace.frames.len(), 3);
        assert!(!trace.incomplete);

        assert_eq!(trace.frames[0].function.as_deref(), Some("Object.method"));
        assert_eq!(trace.frames[0].file.as_deref(), Some("/app/src/index.js"));
        assert_eq!(trace.frames[0].line, Some(10));
        assert_eq!(trace.frames[0].column, Some(15));

        assert_eq!(trace.frames[1].function.as_deref(), Some("Module._compile"));
        assert_eq!(
            trace.frames[1].file.as_deref(),
            Some("node:internal/modules/cjs/loader")
        );
        assert_eq!(trace.frames[1].line, Some(1234));
        assert_eq!(trace.frames[1].column, Some(14));

        assert_eq!(trace.frames[2].function, None);
        assert_eq!(trace.frames[2].file.as_deref(), Some("/app/src/helper.js"));
        assert_eq!(trace.frames[2].line, Some(5));
        assert_eq!(trace.frames[2].column, Some(3));
    }

    #[test]
    fn test_parse_v8_stack_anonymous_and_native() {
        let stack = "\
Error: boom
    at <anonymous>:1:1
    at native";

        let trace = parse_v8_stack(stack);
        assert_eq!(trace.frames.len(), 2);

        assert_eq!(trace.frames[0].file.as_deref(), Some("<anonymous>"));
        assert_eq!(trace.frames[0].line, Some(1));
        assert_eq!(trace.frames[0].column, Some(1));

        assert_eq!(trace.frames[1].file.as_deref(), Some("native"));
        assert_eq!(trace.frames[1].line, None);
    }

    #[test]
    fn test_parse_v8_stack_empty() {
        let stack = "Error: something";
        let trace = parse_v8_stack(stack);
        assert_eq!(trace.frames.len(), 0);
        assert!(!trace.incomplete);
    }

    #[test]
    fn test_parse_location_file_line_col() {
        let mut frame = libdd_crashtracker::StackFrame::new();
        parse_location("/app/index.js:42:7", &mut frame);
        assert_eq!(frame.file.as_deref(), Some("/app/index.js"));
        assert_eq!(frame.line, Some(42));
        assert_eq!(frame.column, Some(7));
    }

    #[test]
    fn test_parse_location_node_internal() {
        let mut frame = libdd_crashtracker::StackFrame::new();
        parse_location("node:internal/modules/cjs/loader:1234:14", &mut frame);
        assert_eq!(
            frame.file.as_deref(),
            Some("node:internal/modules/cjs/loader")
        );
        assert_eq!(frame.line, Some(1234));
        assert_eq!(frame.column, Some(14));
    }

    #[test]
    fn test_parse_location_no_column() {
        let mut frame = libdd_crashtracker::StackFrame::new();
        parse_location("/app/index.js:42", &mut frame);
        assert_eq!(frame.file.as_deref(), Some("/app/index.js"));
        assert_eq!(frame.line, Some(42));
        assert_eq!(frame.column, None);
    }

    #[test]
    fn test_parse_location_bare_path() {
        let mut frame = libdd_crashtracker::StackFrame::new();
        parse_location("native", &mut frame);
        assert_eq!(frame.file.as_deref(), Some("native"));
        assert_eq!(frame.line, None);
        assert_eq!(frame.column, None);
    }
}
