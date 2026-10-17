import SwiftUI
import WebKit

/// The same persistent desktop glass, with its shadow and eroding body on
/// separate layers. Native code supplies geometry and owns all call controls.
struct DotsVoiceOrbWebMaterial: UIViewRepresentable {
    let level: Double
    let reducedMotion: Bool
    let running: Bool
    var erosion: Double = 0
    var time: Double = 0
    var scale: Double = 1
    var centerX: Double = 0
    var formationBlur: Double = 0 // Desired blur in screen points.
    @Environment(\.scenePhase) private var scenePhase

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.isOpaque = false
        view.backgroundColor = .clear
        view.scrollView.backgroundColor = .clear
        view.scrollView.isScrollEnabled = false
        view.scrollView.bounces = false
        view.scrollView.contentInsetAdjustmentBehavior = .never
        view.isUserInteractionEnabled = false
        view.isAccessibilityElement = false
        view.accessibilityIdentifier = "dots-voice-orb-material"
        view.navigationDelegate = context.coordinator
        update(view, coordinator: context.coordinator)
        // Inline HTML has no links, external scripts, media, network dependencies or bridges.
        view.loadHTMLString(Self.document, baseURL: nil)
        return view
    }

    func updateUIView(_ view: WKWebView, context: Context) {
        update(view, coordinator: context.coordinator)
    }

    private func update(_ view: WKWebView, coordinator: Coordinator) {
        coordinator.update(view, level: level, paused: !running || scenePhase != .active,
                           reducedMotion: reducedMotion, erosion: erosion, time: time,
                           scale: scale, centerX: centerX, formationBlur: formationBlur)
    }

    static func dismantleUIView(_ view: WKWebView, coordinator: Coordinator) {
        coordinator.dispose(view)
        view.navigationDelegate = nil
        view.stopLoading()
    }

    final class Coordinator: NSObject, WKNavigationDelegate {
        private var ready = false
        private var disposed = false
        private var inFlight = false
        private var generation = 0
        private var state = ""
        private var appliedState = ""

        func update(_ view: WKWebView, level: Double, paused: Bool, reducedMotion: Bool,
                    erosion: Double, time: Double, scale: Double, centerX: Double,
                    formationBlur: Double) {
            guard !disposed else { return }
            func finite(_ value: Double, fallback: Double = 0) -> Double {
                value.isFinite ? value : fallback
            }
            let boundedErosion = min(1, max(0, finite(erosion)))
            let arguments: [String: Any] = [
                "level": min(1, max(0, finite(level))), "paused": paused,
                "reducedMotion": reducedMotion, "erosion": boundedErosion,
                // The full body uses CSS animation, not frame bridge calls.
                "time": !reducedMotion && boundedErosion > 0 && boundedErosion < 1 ? finite(time) : 0,
                "scale": max(0.001, finite(scale, fallback: 1)),
                "centerX": finite(centerX), "formationBlur": max(0, finite(formationBlur))
            ]
            if let data = try? JSONSerialization.data(withJSONObject: arguments, options: [.sortedKeys]),
               let value = String(data: data, encoding: .utf8) { state = value }
            apply(view)
        }

        private func apply(_ view: WKWebView) {
            guard ready && !disposed && !inFlight && !state.isEmpty && appliedState != state else { return }
            // At most one bridge call is outstanding. A busy WebKit process takes
            // the latest native frame next, rather than replaying queued geometry.
            let sending = state
            let epoch = generation
            appliedState = sending
            inFlight = true
            view.evaluateJavaScript("window.ShiYanOrbMaterial.update(\(sending))") { [weak self, weak view] _, error in
                guard let self, !self.disposed, self.generation == epoch else { return }
                self.inFlight = false
                if error != nil { self.appliedState = "" }
                if let view, self.state != sending { self.apply(view) }
            }
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            guard !disposed else { return }
            ready = true
            webView.accessibilityValue = "ready"
            apply(webView)
        }

        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            guard !disposed else { return }
            generation += 1
            ready = false
            inFlight = false
            appliedState = ""
            webView.loadHTMLString(DotsVoiceOrbWebMaterial.document, baseURL: nil)
        }

        func dispose(_ view: WKWebView) {
            guard !disposed else { return }
            if ready { view.evaluateJavaScript("window.ShiYanOrbMaterial.dispose()", completionHandler: nil) }
            disposed = true
            generation += 1
            ready = false
            inFlight = false
            state = ""
            appliedState = ""
        }
    }

    // Material and keyframes are copied verbatim from the current desktop CSS.
    // The 80pt inset keeps the one WebKit viewport stable while native scale and
    // position move the glass; only the inner body receives the erosion mask.
    static let document = #"""
    <!doctype html>
    <html><head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
    <style>
    html,body{width:100%;height:100%;margin:0;overflow:hidden;background:transparent;-webkit-user-select:none;user-select:none}
    .dots-voice-material-light,.dots-voice-material-clip{inset:80px}
    .dots-voice-material-clip{position:absolute;pointer-events:none}
    .dots-voice-material-light{position:absolute;pointer-events:none;border-radius:47% 53% 56% 44% / 47% 39% 61% 53%;box-shadow:0 30px 58px rgba(73,76,194,.27);animation:dots-orb-shape 8s ease-in-out infinite alternate}
    .dots-voice-material{filter:blur(var(--dots-orb-formation-blur,0px));position:relative;width:100%;height:100%;border-radius:47% 53% 56% 44% / 47% 39% 61% 53%;overflow:hidden;transform:translateZ(0);background:radial-gradient(circle at 32% 25%,rgba(255,255,255,.96) 0 7%,transparent 26%),conic-gradient(from 215deg at 48% 50%,#4eafea,#5e60ed 30%,#ab63df 54%,#f38186 72%,#58bedc 94%,#4eafea);box-shadow:inset 14px 12px 28px rgba(255,255,255,.44),inset -18px -20px 36px rgba(43,31,135,.25),0 0 0 1px rgba(255,255,255,.7);animation:dots-orb-shape 8s ease-in-out infinite alternate}
    .dots-voice-material::before,.dots-voice-material::after{content:"";position:absolute;border-radius:50%;filter:blur(7px);mix-blend-mode:screen}
    .dots-voice-material::before{inset:15% 8% 36% 35%;background:rgba(102,224,255,.63);animation:dots-orb-swim 4.8s ease-in-out infinite alternate}
    .dots-voice-material::after{inset:42% 30% 4% 5%;background:rgba(255,123,183,.54);animation:dots-orb-swim-two 5.6s ease-in-out infinite alternate}
    .dots-voice-material-sheen{position:absolute;inset:4px;border-radius:inherit;border:1px solid rgba(255,255,255,.55);box-shadow:inset 4px 5px 10px rgba(255,255,255,.22)}
    .dots-voice-material-core{position:absolute;width:22%;aspect-ratio:1;border-radius:50%;left:39%;top:40%;background:rgba(255,255,255,.42);filter:blur(5px);animation:dots-orb-core-pulse 2.4s ease-in-out infinite}
    /* Match desktop glass without a detached outer ring. */
    .dots-voice-material-halo{display:none}
    .dots-voice-scene[hidden] .dots-voice-material-light,.dots-voice-material-light[hidden],.dots-voice-scene[hidden] .dots-voice-material,.dots-voice-scene[hidden] .dots-voice-material::before,.dots-voice-scene[hidden] .dots-voice-material::after,.dots-voice-scene[hidden] .dots-voice-material-core,.dots-voice-material-clip[hidden] .dots-voice-material,.dots-voice-material-clip[hidden] .dots-voice-material::before,.dots-voice-material-clip[hidden] .dots-voice-material::after,.dots-voice-material-clip[hidden] .dots-voice-material-core{animation-play-state:paused}
    @keyframes dots-orb-shape{0%{border-radius:47% 53% 56% 44% / 47% 39% 61% 53%}100%{border-radius:56% 44% 45% 55% / 39% 54% 46% 61%}}
    @keyframes dots-orb-swim{to{transform:translate(-28px,31px) scale(1.22)}}
    @keyframes dots-orb-swim-two{to{transform:translate(31px,-23px) scale(.78)}}
    @keyframes dots-orb-core-pulse{50%{transform:scale(1.45);opacity:.58}}
    @media(prefers-reduced-motion:reduce){.dots-voice-material-light,.dots-voice-material,.dots-voice-material::before,.dots-voice-material::after,.dots-voice-material-core{animation:none}}
    body.paused .dots-voice-material-light,body.paused .dots-voice-material,body.paused .dots-voice-material::before,body.paused .dots-voice-material::after,body.paused .dots-voice-material-core{animation-play-state:paused}
    body.reduced-motion .dots-voice-material-light,body.reduced-motion .dots-voice-material,body.reduced-motion .dots-voice-material::before,body.reduced-motion .dots-voice-material::after,body.reduced-motion .dots-voice-material-core{animation:none}
    </style></head><body class="paused">
    <div class="dots-voice-material-light" aria-hidden="true"><span class="dots-voice-material-halo"></span></div>
    <div class="dots-voice-material-clip" aria-hidden="true"><div class="dots-voice-material"><span class="dots-voice-material-sheen"></span><span class="dots-voice-material-core"></span></div></div>
    <script>
    (()=>{
      const clip=document.querySelector('.dots-voice-material-clip');
      const light=document.querySelector('.dots-voice-material-light');
      const clamp=(n,a=0,b=1)=>Math.min(b,Math.max(a,n));
      const smooth=t=>{t=clamp(t);return t*t*(3-2*t);};
      let latest=null,disposed=false,fullClip='',fullClipKey='',appliedClip='';
      const render=state=>{
        if(disposed || !state)return;
        const {level=0,paused=true,reducedMotion=false,erosion=0,time=0,scale=1,centerX=0,formationBlur=0}=state;
        const e=clamp(erosion),nativeScale=Math.max(.001,scale);
        document.documentElement.style.setProperty('--dots-orb-voice',String(clamp(level)));
        document.documentElement.style.setProperty('--dots-orb-formation-blur',(Math.max(0,formationBlur)/nativeScale).toFixed(3)+'px');
        document.body.classList.toggle('paused',paused);
        document.body.classList.toggle('reduced-motion',reducedMotion);
        const frontier=smooth(e/.16);
        light.style.opacity=String(1-frontier);
        const diameter=clip.clientWidth*nativeScale;
        if(diameter<=0)return;
        const padding=Math.max(100,diameter*.6)/diameter*100;
        const key=padding.toFixed(3);
        let polygon=fullClip;
        if(e>0 || !polygon || fullClipKey!==key){
          const points=[`${-padding}% ${-padding}%`,`${100+padding}% ${-padding}%`];
          const bottom=(1-e)*100+1.5/diameter*100;
          const t=reducedMotion?0:time;
          for(let i=0;i<=160;i++){
            const local=100+padding-(100+2*padding)*i/160;
            const x=centerX-diameter/2+local/100*diameter;
            const ragged=e>0?Math.sin(x*.31+t*2.7)*2.7+Math.sin(x*.91-t*3)*1.4+Math.cos(x*.11+t)*3:0;
            points.push(local.toFixed(3)+'% '+(bottom+ragged*frontier/diameter*100).toFixed(3)+'%');
          }
          polygon='polygon('+points.join(',')+')';
          if(e===0){fullClip=polygon;fullClipKey=key;}
        }
        if(appliedClip!==polygon){clip.style.clipPath=polygon;appliedClip=polygon;}
      };
      const observer=new ResizeObserver(()=>render(latest));
      observer.observe(clip);
      const onVisibility=()=>{if(document.hidden)document.body.classList.add('paused');else render(latest);};
      document.addEventListener('visibilitychange',onVisibility);
      window.ShiYanOrbMaterial={
        update(state){if(disposed)return;latest=state;render(state);},
        dispose(){
          if(disposed)return;
          disposed=true;latest=null;fullClip='';fullClipKey='';appliedClip='';
          observer.disconnect();document.removeEventListener('visibilitychange',onVisibility);
          document.body.classList.add('paused');document.body.replaceChildren();
        }
      };
    })();
    </script></body></html>
    """#
}
