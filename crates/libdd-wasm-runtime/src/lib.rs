use futures::FutureExt;
use std::{future::Future, pin::Pin, task::Poll};

use libdd_common::runtime::FutureHandle;

#[derive(Debug)]
pub struct NodeRuntime;

pub struct JoinHandle<R> {
    h: Option<futures::future::RemoteHandle<R>>,
}

impl<R> Drop for JoinHandle<R> {
    fn drop(&mut self) {
        self.h.take().map(futures::future::RemoteHandle::forget);
    }
}

pub struct AlreadyJoined;

impl<R: 'static> Future for JoinHandle<R> {
    type Output = Result<R, AlreadyJoined>;

    fn poll(
        self: Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Self::Output> {
        let Some(h) = &mut self.get_mut().h else {
            return Poll::Ready(Err(AlreadyJoined));
        };
        Pin::new(h).poll(cx).map(Ok)
    }
}

impl<R: 'static> FutureHandle<R, AlreadyJoined> for JoinHandle<R> {}

impl libdd_common::runtime::Runtime for NodeRuntime {
    type JoinError = AlreadyJoined;

    type JoinHandle<R: Send + 'static> = JoinHandle<R>;

    fn new() -> std::io::Result<Self>
    where
        Self: Sized,
    {
        Ok(NodeRuntime)
    }

    fn spawn_ref<Fut: Future<Output = R> + Send + 'static, R: Send + 'static>(
        &self,
        f: Fut,
    ) -> Self::JoinHandle<R> {
        let (f, handle) = f.remote_handle();
        wasm_bindgen_futures::spawn_local(f);
        JoinHandle { h: Some(handle) }
    }

    fn sleep(time: std::time::Duration) -> impl Future<Output = ()> + Send {
        let (tx, rx) = futures::channel::oneshot::channel();
        let mut tx = Some(tx);
        let interval = time::Interval::new(time.as_millis() as u64, move || {
            let _ = tx.take().map(|tx| tx.send(()));
        });
        time::SleepFuture { rx, interval }
    }

    type HttpClient = http::NodeClient;

    fn http_client() -> Self::HttpClient {
        http::NodeClient
    }
}

mod http {
    use std::{future::Future, io, ops::Deref, pin::Pin};

    use bytes::Bytes;
    use futures::StreamExt;
    use http_body::Body as _;
    use libdd_common::hyper_migration::Body;
    use wasm_bindgen::prelude::*;

    #[derive(Debug, Clone)]
    pub struct NodeClient;

    impl libdd_common::runtime::HttpClient for NodeClient {
        fn request(
            &self,
            mut req: http::Request<Body>,
        ) -> impl Future<Output = io::Result<http::Response<Body>>> + Send + 'static {
            async move {
                let uri = req.uri();
                let (url, options) = (|| {
                    let url = uri.authority()?.host();
                    let protocol = uri.scheme_str()?;
                    let path = uri.path_and_query()?.as_str();
                    let port = uri.authority()?.port();
                    let port = port.as_ref().map(|p| p.as_str());
                    let method = req.method().as_str();
                    let mut headers = Vec::with_capacity(req.headers().len() * 2);
                    for (k, v) in req.headers() {
                        let Ok(v) = v.to_str() else {
                            continue;
                        };
                        headers.push(k.as_str());
                        headers.push(v);
                    }

                    Some((
                        url,
                        serde_wasm_bindgen::to_value(&RequestOptions {
                            protocol,
                            path,
                            port,
                            method,
                            headers,
                        }),
                    ))
                })()
                .unwrap();
                let (tx, rx) = futures::channel::oneshot::channel();
                let mut tx = Some(tx);
                let js_req = {
                    let https = require_https("https");
                    let options = options.map_err(|e| io::Error::other(e.to_string()))?;
                    let js_req = https.request(
                        url,
                        options,
                        &Closure::new(move |res: HttpResponse| {
                            let code = res.statusCode();
                            tx.take().map(|tx| {
                                tx.send(http::Response::builder().status(code).body(Body::empty()))
                            });
                        }),
                    );
                    HttpRequest { js_req }
                };
                let mut body_stream = BodyStream {
                    body: req.body_mut(),
                };
                loop {
                    let Some(frame) = body_stream.next().await else {
                        break;
                    };
                    let Ok(frame) = frame else {
                        break;
                    };
                    let Some(data) = frame.data_ref() else {
                        continue;
                    };
                    js_req.js_req.write(data.deref());
                }

                js_req.js_req.end();
                rx.await
                    .map_err(io::Error::other)?
                    .map_err(io::Error::other)
            }
        }
    }

    struct HttpRequest {
        js_req: NodeHttpRequest,
    }

    unsafe impl Send for HttpRequest {}

    #[derive(serde::Serialize)]
    struct RequestOptions<'a> {
        protocol: &'a str,
        path: &'a str,
        #[serde(skip_serializing_if = "Option::is_none")]
        port: Option<&'a str>,
        method: &'a str,
        headers: Vec<&'a str>,
    }

    #[wasm_bindgen]
    extern "C" {
        type HttpsModule;

        #[wasm_bindgen(js_name = require)]
        fn require_https(s: &str) -> HttpsModule;

        type NodeHttpRequest;
        type HttpResponse;

        #[wasm_bindgen(method, js_name = readFileSync, structural)]
        fn request(
            me: &HttpsModule,
            url: &str,
            options: JsValue,
            callback: &Closure<dyn FnMut(HttpResponse)>,
        ) -> NodeHttpRequest;

        #[wasm_bindgen(method)]
        fn write(this: &NodeHttpRequest, b: &[u8]);

        #[wasm_bindgen(method)]
        fn end(this: &NodeHttpRequest);

        #[wasm_bindgen(method, getter)]
        fn statusCode(this: &HttpResponse) -> u16;
    }

    struct BodyStream<'a> {
        body: &'a mut libdd_common::hyper_migration::Body,
    }

    impl futures::Stream for BodyStream<'_> {
        type Item = Result<http_body::Frame<Bytes>, anyhow::Error>;

        fn poll_next(
            self: Pin<&mut Self>,
            cx: &mut std::task::Context<'_>,
        ) -> std::task::Poll<Option<Self::Item>> {
            Pin::new(&mut self.get_mut().body)
                .poll_frame(cx)
                .map_err(anyhow::Error::from)
        }
    }
}

mod time {
    use std::{future::Future, pin::Pin, task::Poll};

    use futures::FutureExt;
    use wasm_bindgen::prelude::*;

    #[wasm_bindgen]
    extern "C" {
        fn setInterval(closure: &Closure<dyn FnMut()>, millis: u64) -> f64;
        fn clearInterval(token: f64);
    }

    #[wasm_bindgen]
    pub struct Interval {
        _closure: Closure<dyn FnMut()>,
        token: f64,
    }

    impl Interval {
        pub fn new<F>(millis: u64, f: F) -> Interval
        where
            F: FnMut() + Send + 'static,
        {
            // Construct a new closure.
            let closure = Closure::new(f);

            // Pass the closure to JS, to run every n milliseconds.
            let token = setInterval(&closure, millis);

            Interval { _closure, token }
        }
    }

    // When the Interval is destroyed, clear its `setInterval` timer.
    impl Drop for Interval {
        fn drop(&mut self) {
            clearInterval(self.token);
        }
    }

    pub struct SleepFuture {
        pub rx: futures::channel::oneshot::Receiver<()>,
        pub interval: Interval,
    }

    unsafe impl Send for SleepFuture {}

    impl Future for SleepFuture {
        type Output = ();

        fn poll(self: Pin<&mut Self>, cx: &mut std::task::Context<'_>) -> Poll<Self::Output> {
            self.get_mut().rx.poll_unpin(cx).map(drop)
        }
    }
}
