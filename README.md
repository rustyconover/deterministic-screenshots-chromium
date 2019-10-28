# deterministic-screenshots-chromium

A program to create deterministic screenshots of webpages and render them as videos.
 
If the webpage contains animations or animated gifs but the rate 
at which they refresh is faster than the rate at which screenshots can be captured
you will be missing parts of the animation.

This script uses what is called virtual time and frame control in chrome to control
"time".  Virtual time can be faster or slower than real wall clock time.  But virtual
time is deterministic, meaning that it is disconnected from real time and there will 
be no lost frames because frames/screenshots are only rendered and time advanced as specified.

Upon page load an initial budget of virtual time is assigned to the page, then once
that virtual time has expired a screenshot is created.  Then another amount of virtual
time is added to the webpage and another screenshot is created.  Repeating the loop
of assigning time then creating screenshots create the source frames which will then 
be encoded into a h.264 video by ffmpeg.
 
Chrome's functionality of controlling when webpage frames is not available in Mac OS X.  
This program has only been tested on Linux. 

This program uses chrome-aws-lambda to launch Chrome and ffmpeg-static to execute ffmpeg 
static.  You may wish to change this behavior, it is left as an exercise to the reader. 

## Usage

```
Usage: index.ts [options]

Options:
  --width                  Width of the screenshot in pixels
                                                         [number] [default: 300]
  --height                 Height of the screenshot in pixels
                                                         [number] [default: 300]
  --frameInterval          Interval between frames in milliseconds
                                                        [number] [default: 1000]
  --url                    The url to screenshot             [string] [required]
  --frameCount             The number of frames to create[number] [default: 300]
  --outputFilename         <filename> The filename of the output MP4/H264 file
                                                [string] [default: "output.mp4"]
  --screenshotFormat       The format of screenshots created
                             [string] [choices: "jpeg", "png"] [default: "jpeg"]
  --screenshotJpegQuality  The quality of the JPEG screenshot from 0-100. 100 is
                           best.                          [number] [default: 85]
  --noVideo                Do not encode a video from the created frames
                                                      [boolean] [default: false]
  --keepFrames             Keep the generated frames  [boolean] [default: false]
  --help                   Show help                                   [boolean]
  --version, -V            Show version number                         [boolean]
```

Example call
```
ts-node index.ts -u http://flipclockjs.com/
```

Then view the resulting output.mp4 file that is produced.

## Author 
Author: Rusty Conover <rusty@luckydinosaur.com>

Portions of this code were adapted from Chromium source as such this
program is licensed under a BSD-like license.
