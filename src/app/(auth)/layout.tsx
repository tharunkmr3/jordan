export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen">
      {/* Left side — hero image with logo overlay */}
      <div className="relative hidden w-1/2 lg:block">
        <img
          src="/login_bg.png"
          alt="Indian architecture"
          className="absolute inset-0 h-full w-full object-cover"
        />
        {/* Dark overlay for contrast */}
        <div className="absolute inset-0 bg-black/30" />

        {/* Logo */}
        <div className="absolute top-8 left-8">
          <a href="/" className="flex items-center gap-2.5 text-white">
            <svg
              width="30"
              height="34"
              viewBox="0 0 30 34"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
            >
              <path
                d="M13.4352 0.0177586C18.7894 -0.00801237 24.1436 -0.00573525 29.4977 0.0245945C29.5506 10.2795 30.7276 20.1341 22.5553 27.882C16.2625 33.848 10.6984 33.8766 2.58067 33.717C2.45856 29.4152 2.55535 24.5842 2.55039 20.2424C4.91134 20.2126 7.31537 20.2382 9.68028 20.2424L9.70078 27.1047C15.4825 25.4291 19.2874 22.8085 21.5172 16.9875C22.9124 13.3454 22.7719 10.6081 22.7545 6.7951L13.4078 6.77362L13.4352 0.0177586ZM0.0181674 6.75213C4.44548 6.72359 8.87328 6.72359 13.3004 6.75213L13.2877 13.8937L0.0767611 13.884C-0.048528 11.6958 0.0169779 8.98811 0.0181674 6.75213Z"
                fill="currentColor"
              />
            </svg>
            <span className="text-xl font-semibold tracking-tight">Jordon</span>
          </a>
        </div>

        {/* Bottom tagline */}
        <div className="absolute bottom-8 left-8 right-8">
          <p className="text-lg font-medium text-white/90">
            AI-powered customer support that understands your business.
          </p>
        </div>
      </div>

      {/* Right side — form area */}
      <div className="flex w-full flex-col items-center justify-center px-6 py-12 lg:w-1/2">
        {/* Mobile logo */}
        <div className="mb-8 lg:hidden">
          <a href="/" className="flex items-center gap-2.5 text-foreground">
            <svg
              width="30"
              height="34"
              viewBox="0 0 30 34"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
            >
              <path
                d="M13.4352 0.0177586C18.7894 -0.00801237 24.1436 -0.00573525 29.4977 0.0245945C29.5506 10.2795 30.7276 20.1341 22.5553 27.882C16.2625 33.848 10.6984 33.8766 2.58067 33.717C2.45856 29.4152 2.55535 24.5842 2.55039 20.2424C4.91134 20.2126 7.31537 20.2382 9.68028 20.2424L9.70078 27.1047C15.4825 25.4291 19.2874 22.8085 21.5172 16.9875C22.9124 13.3454 22.7719 10.6081 22.7545 6.7951L13.4078 6.77362L13.4352 0.0177586ZM0.0181674 6.75213C4.44548 6.72359 8.87328 6.72359 13.3004 6.75213L13.2877 13.8937L0.0767611 13.884C-0.048528 11.6958 0.0169779 8.98811 0.0181674 6.75213Z"
                fill="currentColor"
              />
            </svg>
            <span className="text-xl font-semibold tracking-tight">Jordon</span>
          </a>
        </div>

        <div className="w-full max-w-sm">{children}</div>

        {/* Footer */}
        <p className="mt-12 text-center text-xs text-muted-foreground">
          <a href="https://jordon.ai/privacy" className="hover:underline">Privacy</a>
          {" · "}
          <a href="https://jordon.ai/terms" className="hover:underline">Terms</a>
        </p>
      </div>
    </div>
  );
}
