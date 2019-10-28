/* A program to create deterministic screenshots of webpages and render them
 * as videos.
 * 
 * For example if the webpage contains animations or animated gifs but the rate 
 * at which they refresh is faster than the rate at which screenshots can be captured
 * you will be missing parts of the animation.
 * 
 * This script uses what is called virtual time and frame control in chrome to control
 * "time".  Virtual time can be faster or slower than real wall clock time.
 * 
 * Upon page load an initial budget of virtual time is assigned to the page, then once
 * that virtual time has expired a screenshot is created.  Then another amount of virtual
 * time is added to the webpage and another screenshot is created.  Repeating the loop
 * of assigning time then creating screenshots create the source frames which will then 
 * be encoded into a h.264 video by ffmpeg.
 * 
 * Chrome's functionality of controlling when webpage frames is not available in Mac OS X.  
 * This program has only been tested on Linux. 
 * 
 * This program uses chrome-aws-lambda to launch Chrome and ffmpeg-static to execute ffmpeg 
 * static.  You may wish to change this behavior, it is left as an exercise to the reader.
 * 
 * Author: Rusty Conover <rusty@luckydinosaur.com>
 *
 * Portions of this code were adapted from Chromium source as such this
 * program is licensed under a BSD-like license.
 */
process.env['AWS_LAMBDA_FUNCTION_NAME'] = 'testing';
process.env.AWS_EXECUTION_ENV = 'AWS_Lambda_nodejs10.x';
process.env.LD_LIBRARY_PATH = '';


const ChromeRemoteInterface = require('chrome-remote-interface');
import * as ChromeLauncher from 'chrome-launcher';
const ChromeAWS = require('chrome-aws-lambda');
const request = require('request-promise-native');
import * as ffmpegStatic from 'ffmpeg-static';
const ffmpeg = require('fluent-ffmpeg');
import * as fs from 'fs';
const yargs = require('yargs');

var argv = yargs
    .usage('deterministic-chromium-screenshots\n\nCreate deterministic screenshots of webpages using Chromium\nwith virtual time.\n\nUsage: $0 [options]')
    .options({
        width: {
            type: 'number',
            description: "Width of the screenshot in pixels",
            default: 300,
        },
        height: {
            type: 'number',
            description: "Height of the screenshot in pixels",
            default: 300,
        },
        frameInterval: {
            type: 'number',
            description: "Interval between frames in milliseconds",
            default: 1000,
        },
        url: {
            type: 'string',
            description: "The url to screenshot",
            //            default: 'http://flipclockjs.com/',
            require: true,
        },
        frameCount: {
            type: 'number',
            description: "The number of frames to create",
            default: 300,
        },
        outputFilename: {
            type: 'string',
            description: "<filename> The filename of the output MP4/H264 file",
            default: "output.mp4",
        },
        screenshotFormat: {
            type: 'string',
            description: "The format of screenshots created",
            default: 'jpeg',
            choices: ['jpeg', 'png'],
        },
        screenshotJpegQuality: {
            type: 'number',
            description: "The quality of the JPEG screenshot from 0-100. 100 is best.",
            default: 85,
        },
        noVideo: {
            type: 'boolean',
            description: "Do not encode a video from the created frames",
            default: false,
        },
        keepFrames: {
            type: 'boolean',
            description: "Keep the generated frames",
            default: false,
        }
    })
    .help('help')
    .strict(true)
    .version('version', '0.0.1').alias('version', 'V')
    .argv;


// Specify the dimensions of the browser viewport this will 
// also be the dimensions of the created video.
const windowWidth = argv.width;
const windowHeight = argv.height;

// How much time should be granted between each frame.
const timeBetweenFramesInMilliseconds = argv.frameInterval;

// The URL of the website where the screenshots will be taken.
const targetUrl = argv.url;

// The total number of frames to capture
// the duration of the video produced will be totalFramesToCapture * timeBetweenFramesInMilliseconds
const totalFramesToCapture = argv.frameCount;

// The filename of the video to produce.
const outputMP4Filename = argv.outputFilename;

// Chrome can produce screenshots in either png or jpeg format, specify the options for that.
const screenshotOptions: ScreenshotOptions = argv.screenshotFormat === 'jpeg' ? {
    format: argv.screenshotFormat,
    quality: argv.screenshotJpegQuality
} : { format: 'png' };



/* Describe the options for creating a screenshot */
interface ScreenshotOptions {
    format: 'jpeg' | 'png';
    quality?: number;
};

/**
 * A helper class to manage virtual time and automatically generate animation
 * frames within the granted virtual time interval.
 * 
 * Adapted from:
 * https://github.com/chromium/chromium/blob/master/headless/test/data/protocol/helpers/virtual-time-controller.js
 */
class VirtualTimeController {
    private readonly browser: any;
    private readonly animationFrameInterval_: number;
    private readonly maxTaskStarvationCount_: number;
    private virtualTimeBase_: number;
    private remainingBudget_: number;
    private lastGrantedChunk_: number;
    private totalElapsedTime_: number;
    private onInstalled_?: (virtualTimeBase: number) => void;
    private onExpired_?: (totalElaspsedTime: number) => void;

    /**
     * @param {!TestRunner} testRunner Host TestRunner instance.
     * @param {!Proxy} dp DevTools session protocol instance.
     * @param {?number} animationFrameInterval in milliseconds, integer.
     * @param {?number} maxTaskStarvationCount Specifies the maximum number of
     *     tasks that can be run before virtual time is forced forward to prevent
     *     deadlock.
     */
    constructor(
        chrome: any,
        animationFrameInterval?: number,
        maxTaskStarvationCount?: number,
    ) {
        this.browser = chrome;
        this.animationFrameInterval_ = animationFrameInterval || 16;
        this.maxTaskStarvationCount_ = maxTaskStarvationCount || 100 * 1000;
        this.virtualTimeBase_ = 0;
        this.remainingBudget_ = 0;
        this.lastGrantedChunk_ = 0;
        this.totalElapsedTime_ = 0;

        this.browser.on('Emulation.virtualTimeBudgetExpired', async () => {
            this.totalElapsedTime_ += this.lastGrantedChunk_;
            this.remainingBudget_ -= this.lastGrantedChunk_;
            if (this.remainingBudget_ === 0) {
                if (this.onExpired_) {
                    this.onExpired_(this.totalElapsedTime_);
                }
            } else {
                await this.issueAnimationFrameAndScheduleNextChunk_();
            }
        });
    }

    /**
     * Grants initial portion of virtual time.
     * @param {number} budget Virtual time budget in milliseconds.
     * @param {number} initialVirtualTime Initial virtual time in milliseconds.
     * @param {?function()} onInstalled Called when initial virtual time is
     *     granted, parameter specifies virtual time base.
     * @param {?function()} onExpired Called when granted virtual time is expired,
     *     parameter specifies total elapsed virtual time.
     */
    async grantInitialTime(
        budget: number,
        initialVirtualTime: number,
        onInstalled: (virtualTimeBase: number) => void,
        onExpired: (totalElapsedVirtualTime: number) => void,
    ) {
        // Pause for the first time and remember base virtual time.
        this.virtualTimeBase_ = (await this.browser.Emulation.setVirtualTimePolicy(
            { initialVirtualTime, policy: 'pause' },
        )).virtualTimeTicksBase;
        // Renderer wants the very first frame to be fully updated.
        await this.browser.HeadlessExperimental.beginFrame({
            noDisplayUpdates: false,
            frameTimeTicks: this.virtualTimeBase_,
        });
        this.onInstalled_ = onInstalled;
        await this.grantTime(budget, onExpired);
    }

    /**
     * Grants additional virtual time.
     * @param {number} budget Virtual time budget in milliseconds.
     * @param {?function()} onExpired Called when granted virtual time is expired,
     *     parameter specifies total elapsed virtual time.
     */
    async grantTime(
        budget: number,
        onExpired: (totalElapsedTime: number) => void,
    ) {
        this.remainingBudget_ = budget;
        this.onExpired_ = onExpired;
        await this.issueAnimationFrameAndScheduleNextChunk_();
    }

    /**
     * Retrieves current frame time to be used in beginFrame calls.
     * @return {number} Frame time in milliseconds.
     */
    currentFrameTime() {
        return this.virtualTimeBase_ + this.totalElapsedTime_;
    }

    /**
     * Returns the total amount of elapsed virtual time.
     */
    elapsedTime() {
        return this.totalElapsedTime_;
    }

    /**
     * Revokes any granted virtual time, resulting in no more animation frames
     * being issued and final OnExpired call being made.
     */
    stopVirtualTimeGracefully() {
        if (this.remainingBudget_) {
            this.remainingBudget_ = 0;
        }
    }

    async captureScreenshot(options: ScreenshotOptions): Promise<Buffer> {
        const frameTimeTicks = this.currentFrameTime();
        const screenshotData = (await this.browser.HeadlessExperimental.beginFrame(
            {
                frameTimeTicks,
                screenshot: options,
            },
        )).screenshotData;
        // Advance virtual time a bit so that next frame timestamp is greater.
        this.virtualTimeBase_ += 0.01;
        return Buffer.from(screenshotData, 'base64');
    }

    async issueAnimationFrameAndScheduleNextChunk_() {
        if (this.totalElapsedTime_ > 0 && this.remainingBudget_ > 0) {
            const remainder =
                this.totalElapsedTime_ % this.animationFrameInterval_;
            if (remainder === 0) {
                // at the frame boundary?
                const frameTimeTicks =
                    this.virtualTimeBase_ + this.totalElapsedTime_;
                await this.browser.HeadlessExperimental.beginFrame({
                    frameTimeTicks,
                    noDisplayUpdates: true,
                });
            }
        }
        await this.scheduleNextChunk_();
    }

    async scheduleNextChunk_() {
        const lastFrame = this.totalElapsedTime_ % this.animationFrameInterval_;
        const nextAnimationFrame = this.animationFrameInterval_ - lastFrame;
        const chunk = Math.min(nextAnimationFrame, this.remainingBudget_);
        await this.browser.Emulation.setVirtualTimePolicy({
            policy: 'pauseIfNetworkFetchesPending',
            budget: chunk,
            maxVirtualTimeTaskStarvationCount: this.maxTaskStarvationCount_,
            waitForNavigation: this.totalElapsedTime_ === 0,
        });

        this.lastGrantedChunk_ = chunk;
        if (this.onInstalled_) {
            this.onInstalled_(this.virtualTimeBase_);
            this.onInstalled_ = undefined;
        }
    }
}

const onExceptionThrown = (e: any) => {
    let msg = `Remote Exception: `;
    if (e.exceptionDetails.exception) {
        let exception = e.exceptionDetails.exception;
        msg += `${exception.description}`;
    } else {
        msg += ` ${e.exceptionDetails.text}`;
    }
    if (e.exceptionDetails.url) {
        msg += ` at <${e.exceptionDetails.url}>`;
    }
    msg += `:${e.exceptionDetails.lineNumber}`;
    console.log(msg);
};

async function run() {
    // Remove the existing chromium binary because if its there the
    // aws launcher module will not set the proper library paths and
    // fonts so things will be missing.
    if (fs.existsSync('/tmp/chromium')) {
        fs.unlinkSync('/tmp/chromium');
    }

    // Fake out the libraries that we're running inside of a lambda function such that
    // chrome-aws-lambda will provide a chrome executable for use, this simplifies
    // installation of binaries.
    const chromePath = await ChromeAWS.executablePath;
    if (!chromePath) {
        console.error("Unable to find a chromium");
        process.exit(1);
    }

    // Launch Chrome with a set of special flags that make the rendering
    // of frames be deterministic.
    let launchedChrome: any = await ChromeLauncher.launch({
        port: 9223,
        handleSIGINT: true,
        logLevel: 'verbose',
        userDataDir: false,
        ignoreDefaultFlags: true,
        // Grab the path to chrome from the chrome-aws-lambda location
        // as this likely will be running headless.
        chromePath: await ChromeAWS.executablePath,
        chromeFlags: [
            '--run-all-compositor-stages-before-draw',
            '--enable-surface-synchronization',
            '--disable-threaded-animation',
            '--disable-threaded-scrolling',
            '--disable-checker-imaging',
            '--deterministic-mode',
            '--hide-scrollbars',
            '--headless',
            '--no-sandbox',
            '--disable-gpu',
            '--remote-debugging-address=127.0.0.1',
        ],
        startingUrl: 'about:blank',
    });

    // Get the location of the browser endpoint rather than the typical
    // target context of a browser tab.  To successfully call
    // createBrowserContext you must call this from the /browser endpoints
    // of the chrome dev tools.
    const d = await request({
        url: `http://localhost:${launchedChrome.port}/json/version`,
        json: true,
    });

    const cri = await ChromeRemoteInterface({
        port: launchedChrome.port,
        target: d.webSocketDebuggerUrl,
    });

    // Create the new browser context.
    const browserContextId = (await cri.Target.createBrowserContext())
        .browserContextId;

    // Create a target that enables frame control and will use
    // virtual time.
    let target = await cri.Target.createTarget({
        url: 'about:blank',
        width: windowWidth,
        height: windowHeight,
        browserContext: browserContextId,
        enableBeginFrameControl: true,
    });

    // Focus the newly created target, may not be necessary since
    // the browser is running in headless mode.
    await cri.Target.activateTarget({
        targetId: target.targetId,
    });

    // Create a new CRI that will interact with the newly created target
    // that has frame control enabled.
    const newTarget = await ChromeRemoteInterface({
        port: launchedChrome.port,
        target: target.targetId,
    });

    await Promise.all([
        newTarget.Page.enable(),
        newTarget.Log.enable(),
        newTarget.Runtime.enable(),
        newTarget.HeadlessExperimental.enable(),
    ]);

    cri.on('Runtime.exceptionThrown', onExceptionThrown);

    // Create a new virtual time controller for the target
    // that has frame control enabled.  This will allow time to be
    // controlled via budgets rather than the normal system clock.
    const controller = new VirtualTimeController(newTarget);

    const frameCreationStartTime = new Date();

    // Grant an initial budget of 1 millisecond and set the start of time to be 10000 ticks.

    await controller.grantInitialTime(
        1,
        10000,
        async () => {
            // The initial budget has been added to the target and virtual time has been paused.
            // now navigate to the destination page and wait for the load event to complete.
            await newTarget.Page.navigate({ url: targetUrl });
            await newTarget.Page.loadEventFired();
        },
        async () => {
            // The initial virtual time budget has expired, so its time to start the screenshot 
            // and add more virtual time cycle.

            // the current frame that is being saved.
            let frameCounter = 1;

            // Keep a list of all frame filenames that have been created.
            const allFrameFilenames: Array<string> = [];

            // This is a callback that will capture a screenshot write it to a file,
            // increment the frame counter and add more virtual time.
            // Eventually it will exit after the desired number of frames have been captured.
            const timeExpired = async () => {
                const screen = await controller.captureScreenshot(screenshotOptions);
                const frameFilename = `frame-${frameCounter.toString().padStart(7, '0')}.${screenshotOptions.format === 'jpeg' ? 'jpg' : 'png'}`;

                fs.writeFileSync(
                    frameFilename,
                    screen,
                );
                allFrameFilenames.push(frameFilename);
                console.log(allFrameFilenames);
                if (frameCounter++ < totalFramesToCapture) {
                    controller.grantTime(timeBetweenFramesInMilliseconds, timeExpired);
                } else {
                    console.log('Finished capturing frames.');
                    const endTime = new Date();
                    // @ts-ignore
                    const clockTime = endTime - frameCreationStartTime;
                    const virtualTime = controller.elapsedTime();
                    console.log(
                        `Real clock time ${clockTime} virtualTime: ${virtualTime}`,
                    );

                    await newTarget.close();
                    await cri.close();
                    await launchedChrome.kill();

                    if (!argv.noVideo) {
                        const encodeStart = new Date();

                        // Start to create the movies by using ffmpeg.
                        ffmpeg.setFfmpegPath(ffmpegStatic.path);
                        ffmpeg()
                            .input(`frame-%07d.${screenshotOptions.format === 'jpeg' ? 'jpg' : 'png'}`)
                            .inputFPS(1000 / timeBetweenFramesInMilliseconds)
                            .noAudio()
                            .videoCodec('libx264')
                            .outputOptions('-profile:v high')
                            .outputOptions('-level 4.2')
                            // I don't love that we're missing chroma information in this encoding
                            // but it seems for wide compatibility with devices its a necessary
                            // thing to do.
                            .outputOptions('-pix_fmt yuv420p')
                            .fps(1000 / timeBetweenFramesInMilliseconds)
                            .on('error', function (err: any) {
                                console.log('An error occurred: ' + err.message);
                            })
                            .on('end', function () {
                                const encodeEnd = new Date();
                                // @ts-ignore
                                console.log(`Encoding time:`, encodeEnd - encodeStart);

                                if (!argv.keepFrames) {
                                    allFrameFilenames.map(fs.unlinkSync);
                                }
                            })
                            .save(outputMP4Filename);
                    } else {
                        if (!argv.keepFrames) {
                            // Cleanup all of the produced frames.
                            allFrameFilenames.map(fs.unlinkSync);
                        }
                    }
                    console.log('Finished');
                }
            };
            // Grant more time on the virtual clockthe amount granted will be the amount of time
            // between screenshots. When time expires call the handler.
            controller.grantTime(timeBetweenFramesInMilliseconds, timeExpired);
        },
    );
}

run().catch(e => console.error(e));
